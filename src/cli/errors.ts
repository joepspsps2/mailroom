// 引擎回的失敗原因 → 人看得懂的一句話＋下一步。找不到對照的，照實印原因代碼。

const TABLE: Record<string, [string, string]> = {
  not_found: ['No such issue.', 'Check the issue id with `campaign status <id>`; create it with `campaign create` first.'],
  illegal_transition: ['The issue is not in a state where this is allowed.', 'Run `campaign status <id>` to see the current state and what comes next.'],
  illegal_state: ['The issue is not in a state where this is allowed (retry-failed works only while it is sending or paused; a finished (done) issue is closed for good: recipients that failed are recorded with their reason).', 'Run `campaign status <id>` to see the current state.'],
  locked: ['The content is locked: sending has started.', 'Pause the issue first if it must change; a sent issue cannot be edited.'],
  changed_meanwhile: ['The issue changed while the command ran.', 'Run `campaign status <id>` and try again.'],
  conflict: ['An issue with this id already exists.', 'Use a different id or look at the existing one.'],
  domain_held: ['The sender domain is on hold: every newsletter is stopped.', 'Read `campaign status <id>`, then release it with `hold release --note "..." --yes` (or, when this issue paused because of the hold: `campaign release <id> --release-domain`).'],
  preview_required: ['This content has not been previewed yet (or it changed after the preview).', 'Run `campaign preview <id> --yes`, let the owner look at it, then approve.'],
  duplicate_content: ['The same content already exists under another id.', 'Use the existing issue (or see the line above for what to change).'],
  note_required: ['A note is required: who said yes, when, where.', 'Add --note "..."'],
  reason_required: ['A reason is required.', 'Add --reason "..."'],
  not_approved: ['The approval does not match the current content.', 'Preview and approve the current content again.'],
  preflight_not_passed: ['The pre-send check has not passed for the current content.', 'Run `campaign create` again (or fix the source) until the check passes.'],
  web_url_required: ['The issue has no web version URL.', 'Recreate it with --web-url.'],
  bad_time: ['The time could not be understood.', 'Use "YYYY-MM-DD HH:MM" (local time) or a full ISO time.'],
  unknown_plan: ['The warm-up plan does not exist.', 'Define it with the warm-up API before scheduling.'],
  unknown_list: ['The list does not exist.', 'Check the list id.'],
  recipient_not_allowed: ['That address is not on the test recipient list.', 'Test mail only goes to the addresses configured as TEST_RECIPIENTS.'],
  test_recipients_not_configured: ['Test mail is not enabled on this deployment.', 'Set TEST_RECIPIENTS on the Worker.'],
  bad_recipients: ['Give 1 to 10 test addresses.', 'Use --to a@example.com,b@example.com'],
  bad_prefix: ['The subject prefix is not valid.', 'At most 20 characters, no line breaks.'],
  not_uncertain: ['That recipient is not in the "uncertain" state.', 'Run `campaign status <id>` to see who is.'],
  bad_json: ['The request body was not valid JSON.', 'This is a bug in the command: report it.'],
};

export function friendly(reason: string, extra?: string): string {
  const t = TABLE[reason];
  const head = t ? `${t[0]} (${reason})` : `Refused: ${reason}`;
  return [head, extra, t ? `Next: ${t[1]}` : 'Next: read the reason above; `campaign status <id>` shows the current state.'].filter(Boolean).join('\n');
}
