import { KanbanArchParser } from "@web/views/kanban/kanban_arch_parser";
import { exprToBoolean } from "@web/core/utils/strings";
import { extractAttributes } from "@web/core/utils/xml";

export class CrmKanbanArchParser extends KanbanArchParser {
    /**
     * `mobile_pipeline="1"` (the pipeline's arch): on small screens, the
     * pipeline grouped by stage shows one stage at a time (CrmMobilePipeline).
     *
     * @override
     */
    parse(xmlDoc) {
        const archInfo = super.parse(...arguments);
        archInfo.mobilePipeline = exprToBoolean(xmlDoc.getAttribute("mobile_pipeline"));
        return archInfo;
    }

    /**
     * @override
     */
    parseProgressBar(progressBar, fields) {
        const result = super.parseProgressBar(...arguments);
        const attrs = extractAttributes(progressBar, ["recurring_revenue_sum_field"]);
        result.recurring_revenue_sum_field = fields[attrs.recurring_revenue_sum_field] || false;
        return result;
    }
}
