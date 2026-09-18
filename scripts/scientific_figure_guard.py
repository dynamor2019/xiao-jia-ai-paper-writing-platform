"""Publication-style defaults and deterministic layout checks for Matplotlib."""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable

import matplotlib as mpl
from matplotlib.artist import Artist
from matplotlib.axes import Axes
from matplotlib.figure import Figure
from matplotlib.text import Text
from PIL import Image


MIN_FONT_PT = 5.0
MAX_FONT_PT = 7.0
PANEL_LABEL_FONT_PT = 8.0
MIN_RASTER_DPI = 300
OVERLAP_RATIO = 0.08
MAX_INK_COVERAGE = 0.45
MIN_INK_COVERAGE = 0.015
MAX_EMPTY_MARGIN_RATIO = 0.28
NATURE_WIDTH_IN = {"single": 89 / 25.4, "double": 183 / 25.4}
NATURE_MAX_HEIGHT_IN = 170 / 25.4


class FigureQualityError(RuntimeError):
    """Raised when a rendered figure does not meet publication constraints."""


@dataclass(frozen=True)
class FigureIssue:
    """One deterministic figure-quality finding."""

    code: str
    message: str
    artists: tuple[str, ...] = ()


def apply_publication_style(font_family: str = "Arial") -> None:
    """Install restrained journal-ready defaults before creating a figure."""
    mpl.rcParams.update({
        "font.family": "sans-serif",
        "font.sans-serif": [font_family, "DejaVu Sans"],
        "font.size": 6,
        "axes.titlesize": 7,
        "axes.labelsize": 7,
        "xtick.labelsize": 6,
        "ytick.labelsize": 6,
        "legend.fontsize": 6,
        "figure.titlesize": 7,
        "axes.linewidth": 0.6,
        "lines.linewidth": 0.9,
        "lines.markersize": 3.5,
        "savefig.dpi": 600,
        "savefig.bbox": None,
        "pdf.fonttype": 42,
        "ps.fonttype": 42,
        "svg.fonttype": "none",
    })


def _artist_name(artist: Artist) -> str:
    """Return a compact stable description for a report."""
    if isinstance(artist, Text):
        value = " ".join(artist.get_text().split())[:60]
        return f"Text({value!r})"
    return type(artist).__name__


def _visible_text(fig: Figure) -> list[Text]:
    """Collect visible non-empty text artists that participate in layout."""
    return [
        artist for artist in fig.findobj(match=Text)
        if artist.get_visible() and artist.get_text().strip()
    ]


def _intersection_ratio(first, second) -> float:
    """Measure overlap against the smaller bounding-box area."""
    width = max(0.0, min(first.x1, second.x1) - max(first.x0, second.x0))
    height = max(0.0, min(first.y1, second.y1) - max(first.y0, second.y0))
    overlap = width * height
    smaller = min(first.width * first.height, second.width * second.height)
    return overlap / smaller if smaller > 0 else 0.0


def _font_issues(texts: Iterable[Text]) -> list[FigureIssue]:
    """Find labels that will be unreadable or visually dominant at print size."""
    issues = []
    for text in texts:
        size = float(text.get_fontsize())
        value = text.get_text().strip()
        families = {family.lower() for family in text.get_fontfamily()}
        if not families.intersection({"arial", "helvetica", "sans-serif"}):
            issues.append(FigureIssue(
                "FONT_FAMILY",
                "Use Arial or Helvetica-compatible sans-serif type throughout the figure",
                (_artist_name(text),),
            ))
        is_panel_label = value.removeprefix("(").removesuffix(")").islower() and len(value.strip("()")) == 1
        if is_panel_label:
            if abs(size - PANEL_LABEL_FONT_PT) > 0.1 or text.get_fontweight() not in {"bold", 700} or text.get_fontstyle() != "normal":
                issues.append(FigureIssue(
                    "PANEL_LABEL_STYLE",
                    "Panel labels must be 8 pt, bold, upright lowercase letters",
                    (_artist_name(text),),
                ))
            continue
        if size < MIN_FONT_PT:
            issues.append(FigureIssue("FONT_TOO_SMALL", f"{size:g} pt is below {MIN_FONT_PT:g} pt", (_artist_name(text),)))
        elif size > MAX_FONT_PT:
            issues.append(FigureIssue("FONT_TOO_LARGE", f"{size:g} pt exceeds {MAX_FONT_PT:g} pt", (_artist_name(text),)))
    return issues


def _legend_layout_issues(fig: Figure, renderer) -> list[FigureIssue]:
    """Detect clipped legends and direct overlap with plotted marks."""
    issues = []
    for index, axes in enumerate(_content_axes(fig), start=1):
        legend = axes.get_legend()
        if legend is None or not legend.get_visible():
            continue
        legend_box = legend.get_window_extent(renderer=renderer)
        if not fig.bbox.contains(legend_box.x0, legend_box.y0) or not fig.bbox.contains(legend_box.x1, legend_box.y1):
            issues.append(FigureIssue("LEGEND_CLIPPED", f"Legend for data axes {index} extends outside the figure canvas"))
        overlaps_data = any(
            line.get_visible()
            and len(line.get_xydata()) > 0
            and line.get_path().transformed(line.get_transform()).intersects_bbox(legend_box)
            for line in axes.lines
        )
        if not overlaps_data:
            overlaps_data = any(
                patch.get_visible()
                and patch.get_window_extent(renderer=renderer).overlaps(legend_box)
                for patch in axes.patches
            )
        if overlaps_data:
            issues.append(FigureIssue(
                "LEGEND_DATA_OVERLAP",
                f"Legend for data axes {index} overlaps plotted data; move it to reserved space or outside the axes",
            ))
    return issues


def _content_axes(fig: Figure) -> list[Axes]:
    """Return visible axes that contain plotted data."""
    return [axes for axes in fig.axes if axes.get_visible() and axes.axison and axes.has_data()]


def _structure_issues(fig: Figure) -> list[FigureIssue]:
    """Check labels, titles, legends, and annotation density."""
    issues = []
    if fig._suptitle is not None and fig._suptitle.get_text().strip():
        issues.append(FigureIssue(
            "IN_ARTWORK_TITLE",
            "Put the brief figure title in the manuscript caption, not above the artwork",
            (_artist_name(fig._suptitle),),
        ))
    for index, axes in enumerate(_content_axes(fig), start=1):
        if axes.get_title().strip():
            issues.append(FigureIssue(
                "AXES_TITLE",
                f"Data axes {index} has an in-artwork title; use the manuscript caption instead",
            ))
        if not axes.get_xlabel().strip():
            issues.append(FigureIssue("X_LABEL_MISSING", f"Data axes {index} has no x-axis label"))
        if not axes.get_ylabel().strip():
            issues.append(FigureIssue("Y_LABEL_MISSING", f"Data axes {index} has no y-axis label"))
        for label, role in ((axes.get_xlabel(), "x"), (axes.get_ylabel(), "y")):
            if label.rstrip().endswith("."):
                issues.append(FigureIssue("AXIS_LABEL_PUNCTUATION", f"The {role}-axis label must not end with a full stop"))
        handles, labels = axes.get_legend_handles_labels()
        public_labels = [label for label in labels if label and not label.startswith("_")]
        legend = axes.get_legend()
        if len(public_labels) >= 2 and legend is None:
            issues.append(FigureIssue("LEGEND_MISSING", f"Data axes {index} has multiple encoded series but no legend"))
        if legend is not None and legend.get_frame_on():
            issues.append(FigureIssue("LEGEND_FRAME", "Legend frames are not allowed in the Nature profile"))
        legend_location = getattr(legend, "_loc", None) if legend is not None else None
        if legend is not None and legend_location == 0:
            issues.append(FigureIssue("LEGEND_AUTO_LOCATION", "Legend location must be explicit, not loc='best'"))
        annotations = [
            text for text in axes.texts
            if text.get_visible() and text.get_text().strip()
            and len(text.get_text().strip("()")) != 1
        ]
        if len(annotations) > 15:
            issues.append(FigureIssue(
                "ANNOTATION_DENSITY",
                f"Data axes {index} contains {len(annotations)} annotations; keep only decision-relevant labels",
            ))
    return issues


def _composition_issues(fig: Figure, renderer) -> list[FigureIssue]:
    """Reject layout patterns that pass geometry checks but look unpublishable."""
    issues = []
    axes_list = _content_axes(fig)
    if len(axes_list) > 1:
        has_panel_labels = any(
            text.get_text().strip().lower().strip("()") in {chr(code) for code in range(ord("a"), ord("z") + 1)}
            for text in _visible_text(fig)
        )
        if not has_panel_labels:
            issues.append(FigureIssue(
                "MULTIPANEL_LABELS_MISSING",
                "Multi-panel figures require Nature-style panel labels and one coherent caption",
            ))
    for index, axes in enumerate(axes_list, start=1):
        axes_box = axes.get_window_extent(renderer=renderer)
        if axes_box.width < fig.bbox.width * 0.28 or axes_box.height < fig.bbox.height * 0.28:
            issues.append(FigureIssue("PLOT_AREA_TOO_SMALL", f"Data axes {index} uses too little canvas area"))
    return issues


def _caption_issues(caption_title: str | None, caption_text: str | None) -> list[FigureIssue]:
    """Validate the standalone figure legend metadata."""
    issues = []
    title = (caption_title or "").strip()
    text = (caption_text or "").strip()
    if not title:
        issues.append(FigureIssue("CAPTION_TITLE_MISSING", "A brief figure title is required in the manuscript caption"))
    elif len(title) > 120:
        issues.append(FigureIssue("CAPTION_TITLE_LONG", "The brief figure title exceeds 120 characters"))
    if not text:
        issues.append(FigureIssue("CAPTION_TEXT_MISSING", "A standalone caption description is required"))
    elif len(text.split()) > 250:
        issues.append(FigureIssue("CAPTION_TOO_LONG", "The caption exceeds the 250-word initial-submission limit"))
    return issues


def _tick_roles(fig: Figure) -> dict[int, tuple[object, str]]:
    """Map tick labels to their axes and orientation."""
    roles = {}
    for axes in fig.axes:
        for label in axes.get_xticklabels(which="both"):
            roles[id(label)] = (axes, "x_tick")
        for label in axes.get_yticklabels(which="both"):
            roles[id(label)] = (axes, "y_tick")
    return roles


def _overlap_issues(fig: Figure, texts: list[Text], renderer) -> list[FigureIssue]:
    """Find substantial text-to-text collisions after final layout."""
    boxes = [(text, text.get_window_extent(renderer=renderer)) for text in texts]
    roles = _tick_roles(fig)
    issues = []
    for index, (first, first_box) in enumerate(boxes):
        for second, second_box in boxes[index + 1:]:
            first_role = roles.get(id(first))
            second_role = roles.get(id(second))
            if first_role and second_role:
                same_axes = first_role[0] is second_role[0]
                perpendicular = first_role[1] != second_role[1]
                if same_axes and perpendicular:
                    continue
            if _intersection_ratio(first_box, second_box) <= OVERLAP_RATIO:
                continue
            issues.append(FigureIssue(
                "TEXT_OVERLAP",
                "Rendered text bounding boxes overlap",
                (_artist_name(first), _artist_name(second)),
            ))
    return issues


def inspect_figure(fig: Figure) -> list[FigureIssue]:
    """Run deterministic checks against the final Matplotlib renderer."""
    fig.canvas.draw()
    renderer = fig.canvas.get_renderer()
    texts = _visible_text(fig)
    return (
        _font_issues(texts)
        + _structure_issues(fig)
        + _composition_issues(fig, renderer)
        + _legend_layout_issues(fig, renderer)
        + _overlap_issues(fig, texts, renderer)
    )


def inspect_raster(path: str | Path) -> list[FigureIssue]:
    """Check raster dimensions, DPI metadata, and blank output."""
    image_path = Path(path)
    with Image.open(image_path) as image:
        dpi = image.info.get("dpi", (0, 0))
        effective_dpi = min(float(dpi[0]), float(dpi[1])) if len(dpi) >= 2 else 0.0
        issues = []
        if effective_dpi + 1 < MIN_RASTER_DPI:
            issues.append(FigureIssue("RASTER_DPI_LOW", f"Raster DPI is {effective_dpi:.1f}; require at least {MIN_RASTER_DPI}"))
        if image.width < 1000 or image.height < 700:
            issues.append(FigureIssue("RASTER_TOO_SMALL", f"Raster is only {image.width}x{image.height} px"))
        rgb_image = image.convert("RGB")
        extrema = rgb_image.getextrema()
        if all(low == high for low, high in extrema):
            issues.append(FigureIssue("RASTER_BLANK", "Raster contains no visible variation"))
        gray = rgb_image.convert("L")
        mask = gray.point(lambda pixel: 255 if pixel < 248 else 0)
        bbox = mask.getbbox()
        ink_pixels = sum(1 for value in mask.getdata() if value)
        ink_coverage = ink_pixels / max(1, image.width * image.height)
        if ink_coverage < MIN_INK_COVERAGE:
            issues.append(FigureIssue("RASTER_TOO_SPARSE", "Visible content occupies too little of the figure canvas"))
        if ink_coverage > MAX_INK_COVERAGE:
            issues.append(FigureIssue("RASTER_TOO_DENSE", "Visible content is too dense for a clean manuscript figure"))
        if bbox is not None:
            left, top, right, bottom = bbox
            margins = [
                left / image.width,
                top / image.height,
                (image.width - right) / image.width,
                (image.height - bottom) / image.height,
            ]
            if max(margins) > MAX_EMPTY_MARGIN_RATIO:
                issues.append(FigureIssue("RASTER_EXCESS_EMPTY_MARGIN", "Figure has excessive empty whitespace; crop or resize the composition"))
        edge = 2
        edge_regions = (
            rgb_image.crop((0, 0, image.width, edge)),
            rgb_image.crop((0, image.height - edge, image.width, image.height)),
            rgb_image.crop((0, 0, edge, image.height)),
            rgb_image.crop((image.width - edge, 0, image.width, image.height)),
        )
        if any(min(channel[0] for channel in region.getextrema()) < 248 for region in edge_regions):
            issues.append(FigureIssue("RASTER_EDGE_CLIPPED", "Visible content touches the raster edge"))
        return issues


def _write_report(
    path: Path,
    png_path: Path,
    pdf_path: Path,
    issues: list[FigureIssue],
    caption_title: str | None,
    caption_text: str | None,
) -> Path:
    """Write a machine-readable QA milestone beside the figure."""
    report_path = path.with_suffix(".qa.json")
    payload = {
        "status": "PASS" if not issues else "FAIL",
        "png": str(png_path),
        "pdf": str(pdf_path),
        "profile": "Nature",
        "caption_title": caption_title,
        "caption_text": caption_text,
        "issues": [asdict(issue) for issue in issues],
    }
    report_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return report_path


def finalize_figure(
    fig: Figure,
    output: str | Path,
    column: str = "double",
    caption_title: str | None = None,
    caption_text: str | None = None,
) -> tuple[Path, Path, Path]:
    """Apply final layout, validate, and export publication PNG/PDF files."""
    if column not in {"single", "double"}:
        raise ValueError("column must be 'single' or 'double'")
    output_path = Path(output).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    width = NATURE_WIDTH_IN[column]
    current_width, current_height = fig.get_size_inches()
    height = min(NATURE_MAX_HEIGHT_IN, max(2.0, current_height * width / max(current_width, 0.1)))
    fig.set_size_inches(width, height, forward=True)
    fig.set_layout_engine("constrained")
    if hasattr(fig, "align_labels"):
        fig.align_labels()
    layout_issues = inspect_figure(fig) + _caption_issues(caption_title, caption_text)
    png_path = output_path.with_suffix(".png")
    pdf_path = output_path.with_suffix(".pdf")
    fig.savefig(png_path, dpi=600, facecolor="white")
    fig.savefig(pdf_path, facecolor="white")
    issues = layout_issues + inspect_raster(png_path)
    report_path = _write_report(output_path, png_path, pdf_path, issues, caption_title, caption_text)
    if issues:
        summary = "; ".join(f"{issue.code}: {issue.message}" for issue in issues[:8])
        raise FigureQualityError(f"Figure QA failed ({report_path}): {summary}")
    return png_path, pdf_path, report_path


def main() -> int:
    """Validate an already-rendered raster from the command line."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", help="PNG or TIFF figure to validate")
    args = parser.parse_args()
    issues = inspect_raster(args.image)
    print(json.dumps({"status": "PASS" if not issues else "FAIL", "issues": [asdict(issue) for issue in issues]}, ensure_ascii=False, indent=2))
    return 0 if not issues else 2


if __name__ == "__main__":
    raise SystemExit(main())
