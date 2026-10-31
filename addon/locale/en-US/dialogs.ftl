# Dialog copy: preflight · review · execution · undo · result · update history
#
# Noun labels (field names, creator roles, source names, retrieval routes, time
# placeholders) live in src/modules/metadataDisplay.ts; imperative alerts live in
# src/utils/locale.ts. Neither is duplicated here.
# Messages with $ variables are filled by dialogCopy.apply() after mount; the rest
# are resolved in one batch when the dialog opens.

## Common
dlg-common-cancel = Cancel
dlg-common-unnamed-item = Untitled item
dlg-common-not-filled = Not filled

## Preflight progress
dlg-preflight-title = Looking for updates
dlg-preflight-preparing = Getting ready
dlg-preflight-stage-item = Checking item
dlg-preflight-stage-route = Looking up the latest information
dlg-preflight-stage-item-done = Item check finished
dlg-preflight-stage-stopping = Stopping
dlg-preflight-stage-done = Check finished
dlg-preflight-stage-cancelled = Stopped
dlg-preflight-progress = { $done } / { $total } checked
dlg-preflight-current-item = Current item
dlg-preflight-current-stage = Current stage
dlg-preflight-meter = Check progress
dlg-preflight-stopping = Stopping…
dlg-preflight-cancel = Cancel

## Review
dlg-review-title = Confirm metadata update
dlg-review-overview = { $total } items · { $ready } updatable
dlg-review-selection-summary = { $items } items selected · { $ops } changes
dlg-review-selection-help = Only selected content will be updated. Existing content is kept by default.
dlg-review-confirm = Update selected
dlg-review-empty = Nothing to review
dlg-review-nothing-to-update = No updates needed for this item
dlg-review-item-skipped = This item will not be updated.
dlg-review-refresh = Search again
dlg-review-refresh-doi = Look up by DOI
dlg-review-filter-all = All
dlg-review-filter-ready = Ready
dlg-review-filter-identity = Confirm identity
dlg-review-filter-blocked = Unavailable
dlg-review-filter-empty = No items match this filter
dlg-review-fill-all = Select blank fields across all items
dlg-review-fill-all-hint = Select blank fields with new content available across this batch, including empty creator lists, regardless of the sidebar filter. Replacements, attachments and notes must be selected separately. Changes are saved only after you click “Update selected”.
dlg-review-select-attachments = Select all attachments for this item
dlg-review-clear-attachments = Deselect attachments for this item
dlg-review-select-notes = Select all notes for this item
dlg-review-clear-notes = Deselect notes for this item
dlg-review-summary-detail = Fill { $fills } · Replace { $replaces } · Attachments { $attachments } · Notes { $notes }
dlg-review-nav = Items in this review
dlg-review-item-meta = { $title } · { $state }
dlg-review-item-meta-count = { $title } · { $selected } / { $total } selected
dlg-review-count = { $selected } / { $total } selected
dlg-review-status-pending = Checking
dlg-review-status-ready = Updatable
dlg-review-status-blocked = Cannot update
dlg-review-status-skipped = Skipped
dlg-review-status-failed = Lookup failed
dlg-review-status-applied = Updated
dlg-review-status-partial = Partly updated
dlg-review-status-rolled-back = Undone
dlg-review-status-rollback-conflict = Not fully undone
dlg-review-status-identity = Needs confirmation
dlg-review-identity-check = I confirm this is the same work
dlg-review-identity-detail = Matched { $fields }. Please confirm the result belongs to this item.
dlg-review-identity-fields-fallback = title and other details
dlg-review-identity-pending = Until you confirm, nothing checked here is included in the update.
dlg-review-identity-confirmed = Confirmed as the same item; the checked changes will be applied.
dlg-review-col-accept = Use
dlg-review-col-field = Item
dlg-review-col-local = Current
dlg-review-col-incoming = New
dlg-review-diff-table = Current values compared with the values found
dlg-review-accept-field = Use new value: { $field }
dlg-review-fill-empty = Fills a blank field
dlg-review-expand = { $preview } (show full text)
dlg-review-creators-accept = Use the complete list of authors and contributors found
dlg-review-creators-field = Full list
dlg-review-creators-empty = (empty list)
dlg-review-creator-empty = (no name)
dlg-review-section-fields = Fields
dlg-review-section-creators = Authors and contributors
dlg-review-section-attachments = New attachments
dlg-review-section-notes = New notes
dlg-review-section-fields-count = { $count } items
dlg-review-section-creators-meta = Whole list
dlg-review-unnamed-attachment = Untitled attachment
dlg-review-note-label = Note { $index }
dlg-review-note-preview = Preview note
dlg-review-note-empty = (empty note)
dlg-review-additions-hint = New items are only added; existing attachments and notes stay as they are. Watch for duplicates.
dlg-review-excluded = { $count } fields do not apply to this item; their current values were kept
dlg-review-excluded-details = Show details
dlg-review-source = Source: { $source }
dlg-review-source-missing = Not provided
dlg-review-source-unknown = Unknown source
dlg-review-source-douban = Douban Books
dlg-review-technical = Technical details

## Execution progress
dlg-exec-title-update = Updating metadata
dlg-exec-title-undo = Undoing the last update
dlg-exec-progress = { $done } / { $total } items processed
dlg-exec-preparing = Getting ready
dlg-exec-processing = Working
dlg-exec-stage-attachment = Adding the attachments you selected
dlg-exec-stage-note = Adding the notes you selected
dlg-exec-stage-field = Updating the fields you selected
dlg-exec-stage-item-done = This item is done
dlg-exec-close-blocked = Still working — please wait. Closing this window will not undo what is already done.
dlg-exec-note = Finished changes are kept; results appear when everything is done.
dlg-exec-meter-update = Update progress
dlg-exec-meter-undo = Undo progress
dlg-exec-open-failed = Could not open the progress window

## Undo confirmation
dlg-undo-title = Undo the last update
dlg-undo-window-title = Confirm what to undo
dlg-undo-time = Updated at: { $time }
dlg-undo-restore-field = Restore { $field }: { $after } → { $before }
dlg-undo-restore-url = Restore the web address saved before the update
dlg-undo-restore-creators = Restore the authors and contributors from before the update
dlg-undo-remove-attachment = Remove the attachment added by this update (if unchanged since)
dlg-undo-remove-note = Remove the note added by this update (if unchanged since)
dlg-undo-verify-field = { $field }: the actual result needs a manual check and will not be rewritten here
dlg-undo-verify-creators = Authors and contributors: the actual result needs a manual check and will not be rewritten here
dlg-undo-verify-created = What was added needs a manual check and will not be removed here
dlg-undo-note = Existing attachments and notes, and anything edited since, are kept. Whatever cannot be undone safely is listed in the results.
dlg-undo-cancel = Keep the update
dlg-undo-confirm = Undo

## Result
dlg-result-title-update = Update results
dlg-result-title-undo = Undo results
dlg-result-title-retry = Retry results
dlg-result-summary-update = { $applied } items updated · { $partial } partly updated · { $skipped } not updated
dlg-result-summary-undo = { $rolledBack } undone · { $conflicts } kept · { $failed } failed
dlg-result-item = { $title } · { $state }
dlg-result-state-applied = Updated
dlg-result-state-partial = Partly updated
dlg-result-state-failed = Not finished
dlg-result-state-skipped = Not updated
dlg-result-state-rolled-back = Undone
dlg-result-state-rollback-conflict = Something kept
dlg-result-state-unknown = Please check the result
dlg-result-operation = { $label }: { $state }
dlg-result-operation-message = { $label }: { $state }; { $message }
dlg-result-label-creators = Authors and contributors
dlg-result-label-attachment = Attachment added now
dlg-result-label-note = Note added now
dlg-result-op-applied = Updated
dlg-result-op-rolled-back = Undone
dlg-result-op-conflict = Current value kept
dlg-result-op-failed = Not finished
dlg-result-records = View update history
dlg-result-retry = Retry what failed
dlg-result-done = Done

## Update history
dlg-history-title = Update history
dlg-history-batch-running = In progress
dlg-history-batch-completed = Completed
dlg-history-batch-partial = Partly completed
dlg-history-batch-failed = Failed
dlg-history-batch-rolled-back = Undone
dlg-history-batch-rollback-partial = Partly undone
dlg-history-op-planned = Planned
dlg-history-op-applied = Updated
dlg-history-op-failed = Failed
dlg-history-op-rolled-back = Undone
dlg-history-op-rollback-conflict = Not fully undone
dlg-history-kind-field = Field
dlg-history-kind-creators = Authors and contributors
dlg-history-kind-attachment = Attachment
dlg-history-kind-note = Note
dlg-history-headline = { $batches } updates
dlg-history-headline-incomplete = { $batches } updates · { $incomplete } unfinished
dlg-history-subline = { $items } item records · { $ops } operations
dlg-history-subline-attention = { $items } item records · { $ops } operations · { $attention } need attention
dlg-history-empty-headline = No updates yet
dlg-history-unavailable-headline = Update history is unavailable
dlg-history-empty-subline = No update history
dlg-history-none = No details to show
dlg-history-no-operations = No recorded operations
dlg-history-no-items = This update has no item records
dlg-history-latest = Most recent update
dlg-history-earlier = Earlier update { $index }
dlg-history-unfinished = unfinished
dlg-history-batch-meta = Started: { $start } · Finished: { $end } · { $items } items · { $ops } operations
dlg-history-op-values = { $before } → { $after }
dlg-history-source = Source: { $source }
dlg-history-locate = Show in library
dlg-history-locate-title = Find the original item without changing anything
dlg-history-locate-disabled = The original item or its window is gone; the record can still be read
dlg-history-locate-failed = Could not find the original item
dlg-history-technical = Technical details
dlg-history-nav = Choose an update record
dlg-history-reload = Reload
dlg-history-back = Back
