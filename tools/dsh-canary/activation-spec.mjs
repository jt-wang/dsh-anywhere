/**
 * The spec the canary hands DSH's ctx.subagents.startActivation to start one child. DSH 0.2.2-rc.1 and earlier
 * read the task from `request`; 0.2.2-rc.2 reads the same fields from the spec itself and ignores `request`.
 * The spec carries both so one canary runs on every supported line.
 */
export function activationSpec({ provider, label, parent, maxDepth, prompt, signal }) {
  const task = { parent, maxDepth, prompt };
  return { provider, label, ...task, request: task, signal };
}
