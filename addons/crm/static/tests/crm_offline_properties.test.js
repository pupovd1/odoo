import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import { expect, test } from "@odoo/hoot";
import { animationFrame, runAllTimers } from "@odoo/hoot-dom";
import {
    contains,
    defineModels,
    fields,
    getService,
    mountView,
    onRpc,
    toggleActionMenu,
} from "@web/../tests/web_test_helpers";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import {
    CrmLead,
    CrmStage,
    CrmTag,
    CrmTeam,
    mockCrmOffline,
} from "@crm/../tests/mock_server/crm_offline_test_helpers";

/** Leads with properties, defined on their team (as lead_properties in crm). */
class PropertiesCrmTeam extends CrmTeam {
    lead_properties_definition = fields.PropertiesDefinition();

    _records = [
        {
            id: 1,
            name: "Sales",
            sequence: 1,
            lead_properties_definition: [{ name: "budget", string: "Budget", type: "char" }],
        },
        { id: 2, name: "Pre-Sales", sequence: 2 },
    ];
}

class PropertiesCrmLead extends CrmLead {
    lead_properties = fields.Properties({
        string: "Properties",
        definition_record: "team_id",
        definition_record_field: "lead_properties_definition",
    });
}

defineModels([CrmStage, PropertiesCrmTeam, CrmTag, PropertiesCrmLead]);
defineMailModels();

const leadForm = /* xml */ `
    <form js_class="crm_form">
        <sheet>
            <field name="name"/>
            <field name="team_id"/>
            <field name="lead_properties"/>
        </sheet>
    </form>`;

test("[Offline] lead properties: a definition access probe lost with the connection doesn't switch the app offline again", async () => {
    // the network can drop while the framework still believes it's online (an
    // answer to an earlier request arrives late): the requests then fail
    let networkDown = false;
    onRpc("/*", () => (networkDown ? new Response("", { status: 502 }) : undefined));
    const setOffline = mockCrmOffline(["crm.team/has_access"]);
    onRpc("crm.team", "has_access", () => true);
    await mountView({ type: "form", resModel: "crm.lead", resId: 1, arch: leadForm, actionMenus: {} });
    await runAllTimers();
    const offlinePlugin = getService(OfflinePlugin);

    // the lead's property (its team's "Budget") is editable online
    const budgetInput = ".o_field_widget[name=lead_properties] .o_property_field_value input";
    expect(budgetInput).toHaveCount(1);

    // offline, the properties are read-only: no probe
    await setOffline(true);
    expect(budgetInput).toHaveCount(0);
    expect.verifySteps([]);

    // a late answer says online while the network is still down: the field turns
    // editable and probes the definition's access, which fails on the connection
    networkDown = true;
    await setOffline(false);
    await animationFrame();
    expect.verifySteps(["crm.team/has_access"]);
    expect(offlinePlugin.isOffline()).toBe(true);

    // back online for real: the field turns editable again. web's user cache
    // keeps the lost probe's rejection: crm asks the server again, without that
    // cache, and the app stays online
    networkDown = false;
    await setOffline(false);
    await runAllTimers();
    await animationFrame();
    expect(offlinePlugin.isOffline()).toBe(false);
    expect.verifySteps(["crm.team/has_access"]);
    expect(budgetInput).toHaveCount(1);

    // so the definition can be edited, without reloading the page
    await toggleActionMenu();
    await contains(".o-dropdown--menu .o_menu_item:contains(Edit Properties)").click();
    await animationFrame();
    expect(".o_field_widget[name=lead_properties] .o_field_property_open_popover").not.toHaveCount(0);
    expect(".o_notification").toHaveCount(0); // no "can't edit the properties" warning
    // (the field asks again as it turns editable: the server, again)
    expect.verifySteps(["crm.team/has_access"]);
});
