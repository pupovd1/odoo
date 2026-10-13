import { registry } from "@web/core/registry";
import { ShareTargetItem } from "@web/webclient/share_target/share_target_item";
import { onWillStart, useOnChange } from "@odoo/owl";
import { _t } from "@web/core/l10n/translation";
import { useCrmOffline } from "@crm/mobile/offline_hooks";

export class CrmShareTargetItem extends ShareTargetItem {
    static template = "crm.ShareTargetItem";
    static name = _t("Lead");
    static sequence = 4;

    setup() {
        super.setup();
        this.crmOffline = useCrmOffline();
        this.teamsDomain = [["company_id", "in", [this.currentCompany.id, false]]];
        onWillStart(() => this.updateTeams());
        // The teams, not read offline, are read once the connection is back.
        useOnChange(
            () => [this.crmOffline.isOffline()],
            (isOffline) => !isOffline && !this.teamsLoaded && this.updateTeams(),
            { initialRun: false }
        );
    }

    /**
     * Offline, sharing to a lead is unavailable: the teams can't be read, and the
     * file upload and the lead creation need the server. The dialog's buttons are
     * disabled by the framework; the save hook does nothing.
     */
    async checkAndActiveIfNeededUserCompany() {
        if (!this.crmOffline.isOffline()) {
            return super.checkAndActiveIfNeededUserCompany(...arguments);
        }
    }

    async process() {
        if (!this.crmOffline.isOffline()) {
            return super.process(...arguments);
        }
    }

    async updateTeams() {
        if (this.crmOffline.isOffline()) {
            return;
        }
        this.state.teams = await this.orm
            .webSearchRead("crm.team", this.teamsDomain, {
                specification: { id: {}, display_name: {} },
                context: this.context
            })
            .then(({ records }) => records);
        this.state.selected_team = this.state.teams.length
            ? this.state.teams[0]
            : false;
        this.teamsLoaded = true;
    }

    onCompanyChange(companyId) {
        super.onCompanyChange(companyId);
        this.teamsDomain = [["company_id", "in", [this.currentCompany.id, false]]];
        this.teamsLoaded = false; // read for the new company, now or once back online
        this.updateTeams();
    }

    get defaultState() {
        return { ...super.defaultState, teams: [], selected_team: false };
    }

    get hasMultiTeams() {
        return this.state.teams.length > 1;
    }

    get modelName() {
        return "crm.lead";
    }
    get context() {
        return {
            ...super.context,
            default_team_id: this.state.selected_team.id,
        };
    }

    get teamRecordProps() {
        return {
            mode: "readonly",
            values: { team: this.state.selected_team },
            fieldNames: ["team"],
            fields: {
                team: {
                    name: "team",
                    type: "many2one",
                    relation: "crm.team",
                    domain: this.teamsDomain,
                },
            },
            hooks: {
                onRecordChanged: (record) => {
                    this.state.selected_team = record.data.team;
                },
            },
        };
    }
}

registry.category("share_target_items").add("crm", CrmShareTargetItem);
