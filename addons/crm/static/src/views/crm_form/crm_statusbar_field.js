import {
    RottingStatusBarDurationField,
    rottingStatusBarDurationField,
} from "@mail/js/rotting_mixin/rotting_statusbar";
import { registry } from "@web/core/registry";

/**
 * The lead's stage bar: mail's rotting status bar whose stage buttons are
 * available offline, so that moving a lead to another stage offline is saved
 * like any other edit of the form (the framework queues the web_save). Same
 * rendering and behaviour online: the field keeps the class mail's stage bar
 * styles are keyed on.
 */
export class CrmStatusBarField extends RottingStatusBarDurationField {
    static template = "crm.StatusBarField";
}

export const crmStatusBarField = {
    ...rottingStatusBarDurationField,
    component: CrmStatusBarField,
    additionalClasses: [
        ...(rottingStatusBarDurationField.additionalClasses || []),
        "o_field_rotting_statusbar_duration",
    ],
};

registry.category("fields").add("crm_statusbar", crmStatusBarField);
