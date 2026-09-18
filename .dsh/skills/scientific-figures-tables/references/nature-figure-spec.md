# Nature Figure Profile

Use this profile for every manuscript figure unless the selected journal has a stricter rule. Judge all dimensions and type at final publication size.

## Canvas and export

- Use 89 mm for a single-column figure or 183 mm for a double-column figure; never exceed 170 mm in height.
- Prefer editable vector PDF/SVG for plots and diagrams. Also retain a 600 DPI RGB PNG working copy; raster content must be at least 300 DPI.
- Embed fonts and keep text editable. Do not convert labels to outlines or rasterize them.
- Minimize unused white space without crowding panels. Do not resize the exported figure in Word.

## Titles and captions

- Do not put a decorative title or `suptitle` inside the artwork.
- Every figure has a brief title in its manuscript legend: `Fig. N | Brief title.` The following text must make the figure understandable without reading the main text.
- Define every panel, symbol, line, color, abbreviation, sample size, error bar and statistical test in the caption. Report exact `n`; define whether error bars are s.d., s.e.m. or confidence intervals and give exact P values where applicable.
- Keep the initial-submission legend at 250 words or fewer. Explanatory prose belongs in the caption, not inside the plot.

## Typography

- Use Arial or Helvetica consistently, with fonts embedded and editable.
- Normal figure text must be 5–7 pt at final size: axis labels 6–7 pt, tick labels and data annotations 5–6 pt, legend 5–7 pt.
- Panel labels are the only standard exception: lowercase `a`, `b`, `c`, 8 pt, bold and upright, aligned consistently at the upper left. Do not use oversized subplot headings as panel labels.
- Use sentence case. Axis labels have an initial capital and no final full stop. Use SI units and one consistent unit style, such as `Temperature (K)`.
- Avoid colored text, white text on shading, outlines, shadows and other display effects.

## Axes, legends, and annotations

- Every data axis requires an explicit variable label and unit when dimensional. State log scales, normalization, broken axes and truncation visibly and in the caption.
- Use one shared legend for directly comparable panels. Put it in reserved empty space or outside the plotting region; it must never cover data, uncertainty, significance marks or annotations. Use no decorative legend frame.
- Use line style, marker shape or direct labels in addition to color. Keep the same variable encoding throughout the paper.
- Data labels use 5–6 pt type, consistent precision and a visible offset from markers and error bars. Label only decision-relevant values; dense point-by-point labels are forbidden.
- Use restrained strokes: axes about 0.5–0.75 pt, main data lines about 0.8–1.0 pt, with markers distinguishable at final size. Grid lines must remain subordinate to data.

## Composition and color

- A figure answers one primary scientific question. Combine panels only when they form a logically connected, directly comparable set; do not create a collage merely to add information.
- Use accessible, high-contrast colors and redundant encodings. Avoid red/green-only distinctions and rainbow scales.
- Use scale bars rather than magnification values for microscopy images.

## Required QA

1. Run `scientific_figure_guard.finalize_figure()` with `caption_title` and `caption_text`; any failed issue blocks delivery.
2. Open the final-size PNG and inspect legend/data overlap, clipping, crowding, panel balance, color distinction and annotation precision.
3. After any figure revision, re-check its caption, Results, Discussion, Abstract and Conclusion against the final plotted data.

## Official sources

- https://research-figure-guide.nature.com/figures/building-and-exporting-figure-panels/
- https://www.nature.com/nature/for-authors/formatting-guide
- https://www.nature.com/nature/for-authors/initial-submission
- https://www.nature.com/documents/nature-final-artwork.pdf
