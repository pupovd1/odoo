import { Dropdown } from "@web/core/dropdown/dropdown";
import { DropdownItem } from "@web/core/dropdown/dropdown_item";
import { useDropdownState } from "@web/core/dropdown/dropdown_hooks";
import { _t } from "@web/core/l10n/translation";
import { user } from "@web/core/user";
import { useService } from "@web/core/utils/hooks";
import { useCrmOffline } from "@crm/mobile/offline_hooks";

import { Component, onWillStart, proxy, useOnChange } from "@odoo/owl";

export class TeamSwitcher extends Component {
    static template = "crm.team_switcher";
    static components = { Dropdown, DropdownItem };

    /**
     * @override
     */
    setup() {
        super.setup();
        this.actionService = useService("action");
        this.crmOffline = useCrmOffline();
        this.groupState = proxy({ isSaleManager: false });
        this.dropdownState = useDropdownState();

        onWillStart(() => this.loadSaleManagerGroup());
        // Offline the dropdown closes; the group probe, skipped offline, runs once
        // the connection is back.
        useOnChange(
            () => [this.crmOffline.isOffline()],
            (isOffline) => (isOffline ? this.dropdownState.close() : this.loadSaleManagerGroup()),
            { initialRun: false }
        );
    }

    get allTeamsLabel() {
        return _t("All Teams");
    }

    get currentLabel() {
        return this.teams.find((t) => t.id === this.selectedTeamId)?.name || this.allTeamsLabel;
    }

    get hasDropdown() {
        return this.teams.length > 0;
    }

    /**
     * Offline the switcher can't change the team (the pipeline would need a
     * reload with a new domain): the selected team stays as a search facet.
     */
    get isDisabledOffline() {
        return this.crmOffline.isOffline();
    }

    /**
     * Offline the sales-manager probe isn't issued and counts as false, so
     * "Manage Teams" is unreachable.
     */
    get isSaleManager() {
        return !this.crmOffline.isOffline() && this.groupState.isSaleManager;
    }

    get selectedTeamId() {
        return this.env.searchModel.state.switcherTeamId;
    }

    get teams() {
        return this.env.searchModel.state.switcherTeams;
    }

    async loadSaleManagerGroup() {
        if (this.crmOffline.isOffline() || this.saleManagerGroupLoaded) {
            return;
        }
        this.saleManagerGroupLoaded = true;
        this.groupState.isSaleManager = await user.hasGroup("sales_team.group_sale_manager");
    }

    onClickManageTeams() {
        if (this.crmOffline.isOffline()) {
            return;
        }
        this.actionService.doAction("sales_team.crm_team_action_config");
    }

    /**
     * Change the currently selected team:
     * - crm.lead records are filtered to that team + team-less records
     * - only that team's stages are shown + the stages of team-less records
     * - the team becomes the default when creating a new crm.lead or crm.stage
     * @param {Number} teamId Id of the new selected team, "undefined" fallbacks on "All Sales Team".
     */
    onSelect(teamId) {
        if (this.crmOffline.isOffline() || this.selectedTeamId === teamId) {
            return;
        }
        this.env.searchModel._updateSwitcherSelection(teamId);
    }
};
