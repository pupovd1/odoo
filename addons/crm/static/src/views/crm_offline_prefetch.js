import { Component, proxy, t, usePlugin, useProps } from "@odoo/owl";
import { _t } from "@web/core/l10n/translation";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { useService } from "@web/core/utils/hooks";
import { browser } from "@web/core/browser/browser";
import { parseXML } from "@web/core/utils/xml";
import {
    addFieldDependencies,
    extractFieldsFromArchInfo,
    getBasicEvalContext,
    getFieldsSpec,
} from "@web/model/relational_model/utils";
import { loadSubViews } from "@web/views/form/form_controller";
import { FormArchParser } from "@web/views/form/form_arch_parser";

const PREFETCH_META_KEY = "crm.offline_prefetch_meta";
const DEFAULT_FORM_CAP = 50;

/**
 * Prefetch the current CRM pipeline into the offline RPC / visited caches.
 */
export class CrmOfflinePrefetch extends Component {
    static template = "crm.OfflinePrefetch";
    props = useProps({
        getDomain: t.function().optional(),
        getContext: t.function().optional(),
        formCap: t.number().optional(DEFAULT_FORM_CAP),
    });

    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
        this.viewService = useService("view");
        this.ui = useService("ui");
        this.offlinePlugin = usePlugin(OfflinePlugin);
        this.state = proxy({
            running: false,
            progress: 0,
            total: 0,
            lastResult: this._readMeta(),
        });
    }

    _readMeta() {
        try {
            return JSON.parse(browser.localStorage.getItem(PREFETCH_META_KEY) || "null");
        } catch {
            return null;
        }
    }

    _writeMeta(meta) {
        browser.localStorage.setItem(PREFETCH_META_KEY, JSON.stringify(meta));
        this.state.lastResult = meta;
    }

    get buttonLabel() {
        if (this.state.running) {
            return _t("Prefetching… %(done)s/%(total)s", {
                done: this.state.progress,
                total: this.state.total || "?",
            });
        }
        return _t("Make available offline");
    }

    get isDisabled() {
        return this.state.running || this.offlinePlugin.isOffline();
    }

    async onPrefetch() {
        if (this.isDisabled) {
            return;
        }
        this.state.running = true;
        this.state.progress = 0;
        const domain = this.props.getDomain?.() || [];
        const context = this.props.getContext?.() || {};
        // Form web_read uses the action context. The kanban search context adds
        // keys such as team_switcher_enabled, which would miss the form cache.
        const actionId = this.env.config?.actionId;
        const viewType = this.env.config?.viewType || "kanban";

        try {
            const model = this.env.model;
            // Same RPC the open kanban/list will replay (grouped webReadGroup or
            // ungrouped webSearchRead), not a hand-written smaller specification.
            let allIds = model ? await this._cacheCurrentView(model) : [];
            if (allIds.length < this.props.formCap) {
                const moreIds = await this.orm.search("crm.lead", domain, {
                    limit: this.props.formCap,
                    context,
                });
                const seen = new Set(allIds);
                for (const id of moreIds) {
                    if (!seen.has(id)) {
                        seen.add(id);
                        allIds.push(id);
                    }
                    if (allIds.length >= this.props.formCap) {
                        break;
                    }
                }
            }

            // Mark current search as available offline
            if (actionId && this.env.searchModel?.getCurrentSearch) {
                await this.offlinePlugin.setAvailableOffline(actionId, viewType, {
                    search: this.env.searchModel.getCurrentSearch(),
                });
                await this.offlinePlugin.setAvailableOffline(actionId, "form", {
                    resId: false,
                });
            }

            // 2) Warm M2X caches
            await Promise.all([
                this._warmM2X("crm.stage", []),
                this._warmM2X("crm.tag", []),
                this._warmM2X("crm.team", []),
                this._warmM2X("crm.lost.reason", []),
                this._warmM2X("res.users", [["share", "=", false]]),
                this._warmM2X("res.partner", [], 40),
            ]);

            // 3) Prefetch forms with the specification the form view webReads
            const formIds = allIds.slice(0, this.props.formCap);
            this.state.total = formIds.length;
            const formContext = this.env.searchModel?.globalContext || context;
            const formKwargs = await this._formWebReadKwargs("crm.lead", formContext);
            for (let i = 0; i < formIds.length; i++) {
                const resId = formIds[i];
                await this.orm.cache({ type: "disk", update: "always" }).webRead(
                    "crm.lead",
                    [resId],
                    formKwargs
                );
                if (actionId) {
                    await this.offlinePlugin.setAvailableOffline(actionId, "form", { resId });
                }
                this.state.progress = i + 1;
            }

            const meta = {
                at: Date.now(),
                recordCount: formIds.length,
                actionId,
            };
            this._writeMeta(meta);
            this.notification.add(
                _t("%(count)s leads ready offline", { count: formIds.length }),
                { type: "success" }
            );
        } catch (e) {
            this.notification.add(_t("Prefetch failed: %s", e.message || e), {
                type: "danger",
            });
        } finally {
            this.state.running = false;
        }
    }

    /**
     * Issue the RPC the current list/kanban model will issue on reload.
     * @param {import("@web/model/relational_model/relational_model").RelationalModel} model
     * @returns {Promise<number[]>}
     */
    async _cacheCurrentView(model) {
        const cache = { type: "disk", update: "always" };
        const config = model.config;
        const ids = [];
        const seen = new Set();
        const pushIds = (pageIds) => {
            for (const id of pageIds) {
                if (id && !seen.has(id)) {
                    seen.add(id);
                    ids.push(id);
                }
            }
        };
        if (config.groupBy?.length) {
            const result = await model._webReadGroup(config, cache);
            pushIds(this._idsFromGroups(result.groups));
            return ids;
        }
        const limit = config.limit || model.initialLimit || 80;
        let offset = config.offset || 0;
        let total = Infinity;
        while (offset < total && ids.length < this.props.formCap) {
            const pageConfig = offset === (config.offset || 0) ? config : { ...config, offset, limit };
            const result = await model._loadUngroupedList(pageConfig, cache);
            total = result.length || 0;
            const pageIds = (result.records || []).map((record) => record.id);
            if (!pageIds.length) {
                break;
            }
            pushIds(pageIds);
            if (pageIds.length < limit) {
                break;
            }
            offset += limit;
        }
        return ids;
    }

    _idsFromGroups(groups, acc = []) {
        for (const group of groups || []) {
            for (const record of group.__records || []) {
                if (record?.id) {
                    acc.push(record.id);
                }
            }
            if (group.__groups?.groups) {
                this._idsFromGroups(group.__groups.groups, acc);
            }
        }
        return acc;
    }

    /**
     * Build the webRead kwargs the form controller uses for this action.
     * Field order follows the form arch, including subviews and display_name.
     */
    async _formWebReadKwargs(resModel, context) {
        const views = this.env.config?.views || [];
        const formDesc = views.find((view) => view[1] === "form");
        const viewId = formDesc ? formDesc[0] : false;
        const { fields, relatedModels, views: loaded } = await this.viewService.loadViews({
            resModel,
            views: [[viewId, "form"]],
            context,
        });
        const archInfo = new FormArchParser().parse(
            parseXML(loaded.form.arch),
            relatedModels,
            resModel
        );
        await loadSubViews(
            archInfo.fieldNodes,
            fields,
            context,
            resModel,
            this.viewService,
            this.ui.isSmall
        );
        const extracted = extractFieldsFromArchInfo(archInfo, fields);
        addFieldDependencies(extracted.activeFields, extracted.fields, [
            { name: "display_name", type: "char", readonly: true },
        ]);
        const specification = getFieldsSpec(
            extracted.activeFields,
            extracted.fields,
            getBasicEvalContext({ context })
        );
        return { context, specification };
    }

    async _warmM2X(resModel, domain, limit = 80) {
        const records = await this.orm
            .cache({ type: "disk", update: "always" })
            .searchRead(resModel, domain, ["id", "display_name"], { limit });
        await this.offlinePlugin.cacheMany2XSearch(resModel, records);
    }
}
