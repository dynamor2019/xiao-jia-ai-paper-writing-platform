import assert from 'node:assert/strict';
import test from 'node:test';

import { validateMarkdownPaper } from './paper-quality-validator.js';

test('blocks the known paper3 failure pattern', () => {
  const markdown = `# Paper
## Theory
**Theorem 2.** Strict inequality when a capacity constraint binds.
The Lagrangian for a capacity constraint is $L(\\lambda)=\\min_p(c_p+\\sum_e w\\lambda_e)$.
Table 1 reports the results.
## References
[1] Source
## 2. Related Work`;
  const report = validateMarkdownPaper(markdown);
  const codes = new Set(report.issues.map((issue) => issue.code));
  assert.equal(report.passed, false);
  assert.ok(codes.has('STRUCTURE_AFTER_REFERENCES'));
  assert.ok(codes.has('PRESENTATION_MISSING_TABLE'));
  assert.ok(codes.has('THEORY_LAGRANGIAN_CONSTANT'));
  assert.ok(codes.has('THEORY_STRICT_SEPARATION_CONDITIONS'));
});

test('accepts structurally complete mathematical content', () => {
  const markdown = `# Paper
## Theory
$$L(\\lambda)=\\min_x f(x)+\\sum_e \\lambda_e g_e(x)-\\sum_e \\lambda_e c_e.$$

| Method | Score |
|---|---:|
| A | 1.0 |

## References
[1] Source`;
  const report = validateMarkdownPaper(markdown);
  assert.equal(report.passed, true);
});

test('blocks figure disorder and causal claims from correlation', () => {
  const markdown = `# Paper
## Results
Correlation analysis confirms that congestion drives the observed gap.
![Figure 1](figure1.png)
![Figure 3](figure3.png)
![Figure 2](figure2.png)
## References
[1] Source`;
  const report = validateMarkdownPaper(markdown);
  const codes = new Set(report.issues.map((issue) => issue.code));
  assert.equal(report.passed, false);
  assert.ok(codes.has('PRESENTATION_FIGURE_ORDER'));
  assert.ok(codes.has('INFERENCE_CAUSAL_FROM_ASSOCIATION'));
});

test('blocks significance stars without exact machine statistics', () => {
  const markdown = `# Paper
## Results
The comparison was significant (*** = p < 0.001).
## References
[1] Source`;
  const report = validateMarkdownPaper(markdown);
  assert.equal(report.passed, false);
  assert.ok(report.issues.some((issue) => issue.code === 'STAT_SIGNIFICANCE_STARS'));
});

test('blocks manual assembly and review outcome promises', () => {
  const markdown = `# Paper
## Results
Table 1 and Figure 1 summarize the experiment.
Remaining manual tasks: manually insert figures and tables.
Expected decision: Strong Accept.
## References
[1] Source`;
  const report = validateMarkdownPaper(markdown, { requireEmbeddedAssets: false });
  const codes = new Set(report.issues.map((issue) => issue.code));
  assert.equal(report.passed, false);
  assert.ok(codes.has('SUBMISSION_MANUAL_ASSEMBLY'));
  assert.ok(codes.has('SUBMISSION_FALSE_REVIEW_PROMISE'));
});

test('blocks weak submission claims found in AIC-style routing manuscripts', () => {
  const markdown = `# Paper
## Method
For each commodity $k$ with $y_k > 0$, a pricing subproblem finds paths. No negative-reduced-cost path remains, so the LP optimum is certified.
This is for the first time applied to BIM routing.
## Experiments
The IFC routing benchmark uses synthetic unit capacity and seeded terminal pairs.
## Data Availability
All data, code, and validation scripts are provided for reproducibility. The repository URL will be added upon acceptance. The scenarios were preregistered.
## References
[1] Source`;
  const report = validateMarkdownPaper(markdown, { requireEmbeddedAssets: false });
  const codes = new Set(report.issues.map((issue) => issue.code));
  assert.equal(report.passed, false);
  assert.ok(codes.has('THEORY_CG_PARTIAL_PRICING'));
  assert.ok(codes.has('THEORY_CG_ASSIGNMENT_DUAL_MISSING'));
  assert.ok(codes.has('EXPERIMENT_ENGINEERING_REALISM_ANCHOR'));
  assert.ok(codes.has('REPRO_REPOSITORY_NOT_AVAILABLE'));
  assert.ok(codes.has('REPRO_UNSUPPORTED_PREREGISTRATION'));
  assert.ok(codes.has('CLAIM_UNVERIFIED_FIRSTNESS'));
});
