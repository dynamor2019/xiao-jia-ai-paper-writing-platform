---
name: academic-humanizer
description: Audit and conservatively polish Chinese or English research prose for clarity and scholarly voice while preserving evidence, limitations, citations and AI disclosures. Use during DSH drafting and polishing, not as a scientific gate or AI-detector evasion tool.
---

# Academic Humanizer for DSH

Adaptation informed by [AIScientists-Dev/academic-humanizer](https://github.com/AIScientists-Dev/academic-humanizer), v0.3.3 (MIT, Copyright 2026 AIScientists-Dev). DSH adds evidence protection and bounded, checkpointed execution; upstream rules do not override research integrity or journal requirements.

## Drafting

Lead each paragraph with its supported point. Explain evidence, interpretation and scope without boilerplate introductions, hype or repeated apologies. Keep necessary uncertainty and methods limitations. Use consistent field terminology rather than decorative synonyms. Retain appropriate passive voice and first-person scholarly usage where the venue permits them. Match author voice only when actual author samples are supplied.

## Editing Existing Prose

1. Audit first: record section and line, editorial pattern, evidence anchor and uncertainty. A long sentence, connective or specialist word is a review suggestion, never automatic evidence of AI authorship.
2. Perform one conservative edit within the existing DSH polishing request. Remove empty framing, redundant intensifiers and mechanical transitions; split difficult sentences when clarity improves. No minimum long/short sentence quota or word blacklist.
3. Compare against the source: preserve paragraph coverage, numeric values and units, references, equations, symbols, named methods, tables/code, assumptions, generated-data labels, failures, null and unknown outcomes. Do not add anecdotes, metrics, baselines or favorable findings. Unsafe edits retain the original and proceed to substantive review, not a paid rewrite loop.
4. Report actual changes and rejected changes in `academic-style-audit.md`. Local checks cover measurable drift, not complete semantic equivalence; the existing scientific and citation reviews remain responsible for claims and references.

## DSH Boundaries

- Run within `section-writing` and `polishing`, before `quality-validation`; do not add a twenty-first stage, extra audit model call, new provider or model route.
- Preserve existing checkpoints and targeted literature repair. Do not rewrite completed sections, reset review caches/budgets or resume blocked work merely to improve style.
- Reference adequacy and recency follow the existing literature gate and the target journal. Synthesizing sources does not mean capping citations or shrinking the bibliography to one or two references.
- Evidence-based qualification is not defensive writing. If interpretation needs changing, flag it for substantive review rather than quietly strengthening or weakening the conclusion.
- Never claim detector immunity, human authorship, scientific PASS, author acceptance or submission readiness from language polish. Keep required AI-use disclosure. No automatic provenance removal or accepting tracked changes; blind-review anonymization requires a separate authorized copy.
- Proposed work in a grant must remain proposed; do not present it as completed research. Grant editing is separate from the research-paper pipeline.
- `de-aigc` is a compatibility entry point for this clarity-first workflow, not an additional rewrite pass.
