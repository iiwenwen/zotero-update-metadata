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
dlg-preflight-title = Retrieving source information
dlg-preflight-preparing = Getting ready
dlg-preflight-stage-item = Checking item
dlg-preflight-stage-route = Retrieving source information
dlg-preflight-stage-item-done = Item check complete
dlg-preflight-stage-stopping = Stopping
dlg-preflight-stage-done = Check complete
dlg-preflight-stage-cancelled = Stopped
dlg-preflight-progress = { $done } / { $total } checked
dlg-preflight-current-item = Current item
dlg-preflight-current-stage = Current stage
dlg-preflight-meter = Check progress
dlg-preflight-stopping = Stopping…
dlg-preflight-cancel = Cancel

## Review
dlg-review-title = Review item updates
dlg-review-overview = { $total } items · { $ready } updatable
dlg-review-selection-summary = { $items } items selected · { $ops } changes selected
dlg-review-selection-help = Select the content to update. Then click “Update selected”.
dlg-review-confirm = Update selected
dlg-review-empty = No content to review
dlg-review-nothing-to-update = No updates found
dlg-review-item-skipped = This item was not updated.
dlg-review-refresh = Search again
dlg-review-refresh-doi = Look up by DOI
dlg-review-filter-all = All
dlg-review-filter-ready = Ready
dlg-review-filter-identity = Identity review required
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
dlg-review-status-skipped = Not updated
dlg-review-status-failed = Lookup failed
dlg-review-reason-unsupported = Source not supported
dlg-review-reason-no-result = No item information retrieved
dlg-review-reason-access-denied = Access denied by source
dlg-review-reason-rate-limited = Access limited by source
dlg-review-reason-invalid-response = Source information could not be read
dlg-review-status-applied = Updated
dlg-review-status-partial = Partly completed
dlg-review-status-rolled-back = Undone
dlg-review-status-rollback-conflict = Not fully undone
dlg-review-status-identity = Identity review required
dlg-review-identity-check = This is the same item
dlg-review-identity-detail = Matched: { $fields }. Confirm that the source refers to the current item.
dlg-review-identity-fields-fallback = title and other basic information
dlg-review-identity-pending = This item is excluded from the update until its identity is confirmed.
dlg-review-identity-confirmed = Identity confirmed. Click “Update selected” to update this item.
dlg-review-col-accept = Use
dlg-review-col-field = Item
dlg-review-col-local = Current
dlg-review-col-incoming = Source content
dlg-review-diff-table = Current content compared with source content
dlg-review-accept-field = Use source content: { $field }
dlg-review-fill-empty = Fills a blank field
dlg-review-expand = { $preview } (show full text)
dlg-review-creators-accept = Use the complete list of authors and contributors from the source
dlg-review-creators-field = Full list
dlg-review-creators-empty = (no authors or contributors)
dlg-review-creator-empty = (empty name)
dlg-review-section-fields = Fields
dlg-review-section-creators = Authors and contributors
dlg-review-section-attachments = New attachments
dlg-review-section-notes = New notes
dlg-review-section-fields-count = { $count } items
dlg-review-section-creators-meta = Whole list
dlg-review-unnamed-attachment = Untitled attachment
dlg-review-note-label = Note { $index }
dlg-review-note-preview = Preview note
dlg-review-note-empty = (empty note content)
dlg-review-additions-hint = Attachments and notes are only added. Review them for duplicates.
dlg-review-excluded = { $count } fields do not apply to this item and were excluded.
dlg-review-excluded-details = Show details
dlg-review-source = Source: { $source }
dlg-review-source-missing = Not provided
dlg-review-source-unknown = Unknown source
dlg-review-source-douban = Douban Books
dlg-review-technical = Technical details

## Execution progress
dlg-exec-title-update = Updating items
dlg-exec-title-undo = Undoing the last update
dlg-exec-progress = { $done } / { $total } items processed
dlg-exec-preparing = Getting ready
dlg-exec-processing = Working
dlg-exec-stage-attachment = Adding attachments
dlg-exec-stage-note = Adding notes
dlg-exec-stage-field = Updating fields
dlg-exec-stage-item-done = Item processing complete
dlg-exec-close-blocked = The update is not complete. Wait for processing to finish. Closing this window does not undo completed changes.
dlg-exec-note = The selected content is being processed. Results appear when processing ends. Completed changes are kept.
dlg-exec-meter-update = Update progress
dlg-exec-meter-undo = Undo progress
dlg-exec-open-failed = Could not open the progress window

## Undo confirmation
dlg-undo-title = Undo the last update
dlg-undo-window-title = Confirm undo
dlg-undo-time = Updated at: { $time }
dlg-undo-restore-field = Restore { $field }: { $after } → { $before }
dlg-undo-restore-url = Restore the URL from before the update
dlg-undo-restore-creators = Restore the authors and contributors from before the update
dlg-undo-remove-attachment = Remove an attachment added by this update if it has not changed
dlg-undo-remove-note = Remove a note added by this update if it has not changed
dlg-undo-verify-field = { $field }: verify the result manually. This undo will not change it.
dlg-undo-verify-creators = Authors and contributors: verify the result manually. This undo will not change them.
dlg-undo-verify-created = New content: verify the result manually. This undo will not remove it.
dlg-undo-note = Undo keeps attachments and notes that existed before the update. It also keeps content changed after the update. The results show any content that could not be undone.
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
dlg-result-state-partial = Partly completed
dlg-result-state-failed = Not finished
dlg-result-state-skipped = Not updated
dlg-result-state-rolled-back = Undone
dlg-result-state-rollback-conflict = Some content was not undone
dlg-result-state-unknown = Result requires review
dlg-result-operation = { $label }: { $state }
dlg-result-operation-message = { $label }: { $state }; { $message }
dlg-result-label-creators = Authors and contributors
dlg-result-label-attachment = Attachment
dlg-result-label-note = Note
dlg-result-op-applied = Updated
dlg-result-op-added = Added
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
dlg-history-subline = { $items } items · { $ops } operations
dlg-history-subline-attention = { $items } items · { $ops } operations · { $attention } require attention
dlg-history-empty-headline = No updates yet
dlg-history-unavailable-headline = Update history could not be read
dlg-history-empty-subline = No update history
dlg-history-none = No update details to show
dlg-history-no-operations = No recorded operations
dlg-history-no-items = This update has no item records
dlg-history-latest = Most recent update
dlg-history-earlier = Earlier update { $index }
dlg-history-unfinished = Not finished
dlg-history-batch-meta = Started: { $start } · Finished: { $end } · { $items } items · { $ops } operations
dlg-history-op-values = { $before } → { $after }
dlg-history-source = Source: { $source }
dlg-history-locate = Locate the item in the library
dlg-history-locate-title = Locate the original item without changing it
dlg-history-locate-disabled = The original item or window is unavailable. You can still view the update record.
dlg-history-locate-failed = The original item could not be located
dlg-history-technical = Technical details
dlg-history-nav = Choose an update record
dlg-history-reload = Reload records
dlg-history-back = Back
