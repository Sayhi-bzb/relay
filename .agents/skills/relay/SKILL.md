---
name: relay
description: Process or revise article and chunk briefs and interpretations with the Relay CLI, including resuming unfinished work in this project's content workspaces.
---

# Relay

Use the CLI to persist Agent-written reading views and track their progress. One workspace holds one original article and its processed views.

## Find the requested work

Use `relay config --json` to locate the default workspace and `relay status --json` to inspect progress. For a different article, use `--workspace` on that task's commands; keep the saved default unless the user requests a change.

If `relay` is unavailable, run `node reading-lab/bin/relay.mjs` from the project root. Consult `--help` for parameters and the [CLI guide](../../../reading-lab/docs/cli.md) for initialization, configuration, or source updates.

Match the user's requested units and fields. `article` is the full text; other units use existing chunk IDs. Each unit has independent `brief` and `interpretation` views. Restrict `next` with `--unit` and `--field` when the request targets a subset.

## Read, write, resume

- Use `next --json` to obtain an unfinished field, its original text, the source version, and any previous result. `read --unit ... --view all --json` provides the original and both existing views when revising completed work or checking consistency.
- Read the full original for article-level work. For a chunk, consult surrounding or full-article context when necessary to understand references; keep the result focused on that chunk.
- Generate the requested view, then submit through `write` using a UTF-8 file or stdin. Carry the exact unit, field, and version from the read result into the submission. The CLI saves content; it does not generate it.
- Continue within the requested scope. Successful writes persist immediately, so rerunning scoped `next` resumes unfinished work without a separate checklist.

`next` returning `task: null` means the selected scope has no remaining work; only `ready: true` indicates global completion. Whole-workspace processing ends with `check --json`. For a partial request, report scoped completion and any remaining global work; do not fill unrelated gaps to make `check` pass.

## Write the views

When writing or revising an interpretation, use the project’s [Unicode diagram style](../../../reading-lab/docs/content-style.md) to make relationships visible. Keep brief views concise.

| View | Responsibility |
|---|---|
| `brief` | State the core information directly and concisely, retaining qualifications that change its meaning. |
| `interpretation` | Make the same information easier to understand: explain mechanisms, terms, implications, or examples where supported. Distinguish explanatory context from the source's claims. |

Keep both views consistent with the original and with each other. Article views synthesize the full text; chunk views address their own source passage. Follow the requested audience, language, and length; when continuing an existing workspace without new preferences, keep its established language and tone. Avoid adding chunk titles or extra output fields.

## Handle changes

On `version_conflict`, reread the current original and review or regenerate the affected view before resubmitting. Changing the submitted version alone does not establish that old text is current.

For `workspace_busy`, retry after the active command finishes. If lock ownership cannot be verified, report the blocker and preserve completed work. For structural errors, inspect the reported issue rather than rewriting IDs or removing retained results to force completion.

Use `update` with an edited source copy for requested original-text changes. The [content contract](../../../reading-lab/docs/content-format.md) defines ID preservation, versioning, and retained orphan results. Keep normal processing on the CLI instead of hand-editing those bookkeeping fields.
