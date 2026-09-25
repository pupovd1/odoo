import { Component, proxy, usePlugin } from "@odoo/owl";
import { _t } from "@web/core/l10n/translation";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { useService } from "@web/core/utils/hooks";
import { browser } from "@web/core/browser/browser";

const PREFETCH_META_KEY = "crm.offline_prefetch_meta";
const DEFAULT_FORM_CAP = 50;
const PAGE_SIZE = 80;

/**
 * Prefetch the current CRM pipeline into the offline RPC / visited caches.
 */
export class CrmOfflinePrefetch extends Component {
    static template = "crm.OfflinePrefetch";
    static props = {
        "*": true,
        getDomain: { type: Function, optional: true },
        getContext: { type: Function, optional: true },
        formCap: { type: Number, optional: true },
    };
    static defaultProps = {
        formCap: DEFAULT_FORM_CAP,
    };

    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
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
        const actionId = this.env.config?.actionId;
        const viewType = this.env.config?.viewType || "kanban";

        try {
            // 1) Page through leads to fill RPC disk cache
            let offset = 0;
            let allIds = [];
            let total = 0;
            do {
                const result = await this.orm
                    .cache({ type: "disk", update: "always" })
                    .webSearchRead("crm.lead", domain, {
                        specification: {
                            id: {},
                            display_name: {},
                            stage_id: { fields: { display_name: {} } },
                            partner_id: { fields: { display_name: {} } },
                            user_id: { fields: { display_name: {} } },
                            tag_ids: { fields: { display_name: {}, color: {} } },
                            expected_revenue: {},
                            priority: {},
                            activity_ids: {},
                        },
                        offset,
                        limit: PAGE_SIZE,
                        context,
                    });
                total = result.length || 0;
                const ids = (result.records || []).map((r) => r.id);
                allIds = allIds.concat(ids);
                offset += PAGE_SIZE;
                this.state.total = Math.min(
                    allIds.length + (offset < total ? total - offset : 0),
                    this.props.formCap
                );
                if (ids.length === 0) {
                    break;
                }
            } while (offset < total && allIds.length < this.props.formCap * 2);

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

            // 3) Prefetch forms (capped)
            const formIds = allIds.slice(0, this.props.formCap);
            this.state.total = formIds.length;
            for (let i = 0; i < formIds.length; i++) {
                const resId = formIds[i];
                await this.orm.cache({ type: "disk", update: "always" }).webRead(
                    "crm.lead",
                    [resId],
                    {
                        specification: {
                            id: {},
                            display_name: {},
                            name: {},
                            stage_id: { fields: { display_name: {} } },
                            partner_id: { fields: { display_name: {} } },
                            user_id: { fields: { display_name: {} } },
                            team_id: { fields: { display_name: {} } },
                            tag_ids: { fields: { display_name: {}, color: {} } },
                            email_from: {},
                            phone: {},
                            expected_revenue: {},
                            probability: {},
                            priority: {},
                            description: {},
                            type: {},
                            active: {},
                            won_status: {},
                            company_currency: {},
                            lead_properties: {},
                        },
                        context,
                    }
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

    async _warmM2X(resModel, domain, limit = 80) {
        const records = await this.orm
            .cache({ type: "disk", update: "always" })
            .searchRead(resModel, domain, ["id", "display_name"], { limit });
        await this.offlinePlugin.cacheMany2XSearch(resModel, records);
    }
}
