"""Reusable figures4papers-inspired Matplotlib helpers for DSH paper figures."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence

import matplotlib as mpl
import matplotlib.pyplot as plt
import numpy as np


PALETTE = {
    "blue_main": "#0F4D92",
    "blue_secondary": "#3775BA",
    "green_1": "#DDF3DE",
    "green_2": "#AADCA9",
    "green_3": "#8BCF8B",
    "red_1": "#F6CFCB",
    "red_2": "#E9A6A1",
    "red_strong": "#B64342",
    "neutral": "#CFCECE",
    "teal": "#42949E",
    "violet": "#9A4D8E",
    "highlight": "#FFD700",
}

DEFAULT_COLORS = [
    PALETTE["blue_main"],
    PALETTE["green_3"],
    PALETTE["red_strong"],
    PALETTE["teal"],
    PALETTE["violet"],
    PALETTE["neutral"],
]


@dataclass(frozen=True)
class FigureStyle:
    """Portable figures4papers-style rendering defaults."""

    font_size: int = 7
    axes_linewidth: float = 0.7
    use_tex: bool = False
    font_family: tuple[str, ...] = ("Arial", "DejaVu Sans", "Helvetica", "sans-serif")


def apply_figures4papers_style(style: FigureStyle | None = None) -> None:
    """Apply the figures4papers house style before creating a figure."""
    resolved = style or FigureStyle()
    mpl.rcParams.update({
        "font.family": "sans-serif",
        "font.sans-serif": list(resolved.font_family),
        "font.size": resolved.font_size,
        "axes.spines.right": False,
        "axes.spines.top": False,
        "axes.linewidth": resolved.axes_linewidth,
        "legend.frameon": False,
        "text.usetex": resolved.use_tex,
        "savefig.dpi": 600,
        "pdf.fonttype": 42,
        "ps.fonttype": 42,
        "svg.fonttype": "none",
    })


def create_subplots(nrows: int = 1, ncols: int = 1, figsize: tuple[float, float] | None = None, **kwargs):
    """Create subplots and return axes as a flattened NumPy array."""
    fig, axes = plt.subplots(nrows=nrows, ncols=ncols, figsize=figsize, **kwargs)
    return fig, np.atleast_1d(axes).ravel()


def make_grouped_bar(
    ax,
    categories: Sequence[str],
    series: Sequence[Sequence[float]],
    labels: Sequence[str],
    ylabel: str = "Value",
    colors: Sequence[str] | None = None,
    annotate: bool = False,
):
    """Draw a grouped bar chart with print-safe edges and optional labels."""
    values = np.asarray(series, dtype=float)
    if values.ndim != 2:
        raise ValueError("series must be a 2D sequence")
    if values.shape[1] != len(categories):
        raise ValueError("len(categories) must match each series length")
    if values.shape[0] != len(labels):
        raise ValueError("labels must match number of series")
    x_positions = np.arange(len(categories))
    width = min(0.82 / max(1, values.shape[0]), 0.34)
    selected = list(colors or DEFAULT_COLORS)
    containers = []
    for index, row in enumerate(values):
        offset = (index - (values.shape[0] - 1) / 2) * width
        bars = ax.bar(
            x_positions + offset,
            row,
            width,
            label=labels[index],
            color=selected[index % len(selected)],
            edgecolor="black",
            linewidth=0.8,
        )
        containers.append(bars)
        if annotate:
            annotate_bars(ax, bars)
    ax.set_xticks(x_positions, categories)
    ax.set_ylabel(ylabel)
    return containers[-1]


def annotate_bars(ax, bars, fmt: str = "{:.2f}", fontsize: int = 6, padding: float = 3) -> None:
    """Add compact numeric labels above bars."""
    for bar in bars:
        height = float(bar.get_height())
        ax.annotate(
            fmt.format(height),
            xy=(bar.get_x() + bar.get_width() / 2, height),
            xytext=(0, padding),
            textcoords="offset points",
            ha="center",
            va="bottom",
            fontsize=fontsize,
        )


def make_trend(
    ax,
    x_values: Sequence[float],
    y_series: Sequence[Sequence[float]],
    labels: Sequence[str],
    colors: Sequence[str] | None = None,
    ylabel: str | None = None,
    xlabel: str | None = None,
    show_shadow: bool = False,
) -> None:
    """Draw comparable trend lines with optional light uncertainty bands."""
    x_array = np.asarray(x_values, dtype=float)
    selected = list(colors or DEFAULT_COLORS)
    for index, y_values in enumerate(y_series):
        y_array = np.asarray(y_values, dtype=float)
        if y_array.shape != x_array.shape:
            raise ValueError("each y series must match x length")
        color = selected[index % len(selected)]
        ax.plot(x_array, y_array, label=labels[index], color=color, linewidth=1.0, marker="o", markersize=3.5)
        if show_shadow:
            spread = np.nanstd(y_array) * 0.08
            ax.fill_between(x_array, y_array - spread, y_array + spread, color=color, alpha=0.12, linewidth=0)
    if ylabel:
        ax.set_ylabel(ylabel)
    if xlabel:
        ax.set_xlabel(xlabel)


def make_heatmap(
    ax,
    matrix: Sequence[Sequence[float]],
    x_labels: Sequence[str] | None = None,
    y_labels: Sequence[str] | None = None,
    cmap: str = "magma",
    cbar_label: str | None = None,
    annotate: bool = False,
) -> None:
    """Draw a compact heatmap with optional readable cell annotations."""
    values = np.asarray(matrix, dtype=float)
    if values.ndim != 2:
        raise ValueError("matrix must be 2D")
    image = ax.imshow(values, cmap=cmap, aspect="auto")
    if x_labels is not None:
        ax.set_xticks(np.arange(len(x_labels)), x_labels)
    if y_labels is not None:
        ax.set_yticks(np.arange(len(y_labels)), y_labels)
    if annotate:
        for row in range(values.shape[0]):
            for col in range(values.shape[1]):
                ax.text(col, row, f"{values[row, col]:.2g}", ha="center", va="center", fontsize=5)
    cbar = ax.figure.colorbar(image, ax=ax, fraction=0.046, pad=0.04)
    if cbar_label:
        cbar.set_label(cbar_label)


def save_style_preview(output: str | Path) -> Path:
    """Create a small deterministic preview of the integrated style."""
    apply_figures4papers_style()
    fig, axes_array = create_subplots(figsize=(3.5, 2.4))
    ax = axes_array[0]
    make_grouped_bar(ax, ["A", "B", "C"], [[1.0, 1.4, 1.8], [0.8, 1.1, 1.5]], ["Proposed", "Baseline"], ylabel="Score", annotate=True)
    ax.legend(loc="upper left", frameon=False)
    fig.tight_layout(pad=0.6)
    path = Path(output).resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path, dpi=600, facecolor="white")
    plt.close(fig)
    return path
