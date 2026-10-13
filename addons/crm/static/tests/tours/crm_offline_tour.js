import { registry } from "@web/core/registry";

/**
 * The offline cycle on a phone, in one run (TestCrmOffline.test_crm_offline_tour,
 * at 375x667 with touch): the pipeline and a lead visited online; then, with the
 * browser's network off, an edit of that lead, a lead created through the mobile
 * quick create, an activity scheduled and the lead marked won, all queued; back
 * online, the framework replays the queue (the test then checks the server).
 *
 * A step switches the network by logging NETWORK_OFF or NETWORK_ON: the test
 * applies the browser's offline network emulation (see test_crm_offline.py).
 */
const NETWORK_OFF = "crm_offline_tour: network off";
const NETWORK_ON = "crm_offline_tour: network on";
const LEAD = "Offline tour opportunity";
const NEW_LEAD = "Lead created offline";
const ACTIVITY = "Call back about the offer";

/** Whether a call_kw request for model/method has completed. */
function requested(model, method) {
    return performance
        .getEntriesByType("resource")
        .some((entry) => entry.name.includes(`/web/dataset/call_kw/${model}/${method}`));
}

registry.category("web_tour.tours").add("crm_offline_tour", {
    steps: () => [
        // online: the pipeline, then the lead (the framework caches both)
        {
            content: "The pipeline, one stage at a time",
            trigger: `.o_crm_mobile_pipeline .o_crm_mobile_card_open:contains(${LEAD})`,
            async run({ click }) {
                performance.clearResourceTimings();
                await click();
            },
        },
        {
            content: "The lead, opened online",
            trigger: `.o_navbar_breadcrumbs .o_last_breadcrumb_item:contains(${LEAD})`,
            async run({ waitUntil }) {
                // the activities and activity types the offline panel reads from the cache
                await waitUntil(
                    () =>
                        requested("mail.activity", "search_read") &&
                        requested("mail.activity.type", "search_read"),
                    { timeout: 10000 }
                );
                console.log(NETWORK_OFF);
            },
        },
        {
            content: "Offline: the framework says so",
            trigger: ".o_menu_systray .o_offline_systray",
        },
        // offline: edit the lead
        {
            content: "Edit the lead",
            trigger: ".o_form_view .o_field_widget[name=expected_revenue] input:visible",
            run: "edit 2500",
        },
        {
            content: "Save: the framework queues the write",
            trigger: ".o_form_status_indicator .o_form_button_save:visible",
            run: "click",
        },
        {
            content: "Saved (queued)",
            trigger: ".o_form_status_indicator:has(.o_form_status_indicator_buttons.invisible)",
        },
        // a new lead through the mobile quick create
        {
            content: "Back to the pipeline, from the cache",
            trigger: ".o_navbar_breadcrumbs .o_back_button",
            run: "click",
        },
        {
            content: "New opens the quick create",
            trigger: ".o_crm_mobile_pipeline",
            run: "click .o_control_panel_main_buttons button.o-kanban-button-new",
        },
        {
            trigger: ".o_bottom_sheet .o_crm_mobile_quick_create [name=name]",
            run: `edit ${NEW_LEAD}`,
        },
        {
            trigger: ".o_crm_mobile_quick_create [name=contact_name]",
            run: "edit Alex Rivera",
        },
        {
            trigger: ".o_crm_mobile_quick_create [name=phone]",
            run: "edit +32 470 12 34 56",
        },
        {
            trigger: ".o_crm_mobile_quick_create [name=email_from]",
            run: "edit alex.rivera@example.com",
        },
        {
            trigger: ".o_crm_mobile_quick_create [name=expected_revenue]",
            run: "edit 4200",
        },
        {
            content: "Add: the create is queued",
            trigger: ".o_crm_mobile_quick_create .o_crm_mobile_quick_create_add:enabled",
            run: "click",
        },
        {
            content: "The new lead shows at once, pending sync",
            trigger: `.o_crm_mobile_pending_card:contains(${NEW_LEAD}) .o_crm_pending_sync`,
        },
        // the lead again, from the cache: schedule an activity, mark it won
        {
            content: "Open the lead again",
            trigger: `.o_crm_mobile_card_open:contains(${LEAD})`,
            run: "click",
        },
        {
            content: "Offline, the lead's activities: pick a type",
            trigger: ".o_crm_offline_activities .o_crm_offline_activity_type",
            run: "selectByLabel /^Call$/",
        },
        {
            trigger: ".o_crm_offline_activities .o_crm_offline_activity_summary",
            run: `edit ${ACTIVITY}`,
        },
        {
            content: "Schedule: the activity create is queued",
            trigger: ".o_crm_offline_activities .o_crm_offline_schedule_button:enabled",
            run: "click",
        },
        {
            content: "The activity shows at once, pending sync",
            trigger: `.o_crm_offline_pending_activity:contains(${ACTIVITY})`,
        },
        {
            content: "Mark the lead won",
            trigger: ".o_form_view .o_statusbar_buttons button[name=action_set_won_rainbowman]:enabled",
            run: "click",
        },
        {
            content: "Shown as won at once",
            trigger: ".o_form_view .ribbon:contains(Won)",
            run() {
                console.log(NETWORK_ON);
            },
        },
        // back online: the framework replays the queue
        {
            content: "Synced: the indicator goes once the queue is empty",
            trigger: "body:not(:has(.o_offline_systray))",
            timeout: 30000,
            async run() {
                // and the app stays online: it doesn't switch offline again
                let switchedOffline = false;
                const observer = new MutationObserver(() => {
                    switchedOffline ||= Boolean(document.querySelector(".o_offline_systray"));
                });
                observer.observe(document.body, { childList: true, subtree: true });
                await new Promise((resolve) => setTimeout(resolve, 2000));
                observer.disconnect();
                if (switchedOffline) {
                    throw new Error("The app switched offline again after the replay");
                }
            },
        },
        {
            content: "The lead, won",
            trigger: ".o_form_view .ribbon:contains(Won)",
        },
    ],
});
