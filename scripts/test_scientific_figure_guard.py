"""Regression tests for Nature-profile scientific figure checks."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

from scientific_figure_guard import (
    FigureQualityError,
    apply_publication_style,
    finalize_figure,
    inspect_figure,
)


class ScientificFigureGuardTest(unittest.TestCase):
    """Verify publication rules that can be checked deterministically."""

    def setUp(self) -> None:
        """Apply the publication profile before each figure is created."""
        apply_publication_style()

    def tearDown(self) -> None:
        """Close figures so tests do not retain renderer state."""
        plt.close("all")

    def test_valid_nature_profile_exports(self) -> None:
        """A labelled, captioned figure should export all milestones."""
        fig, axes = plt.subplots(figsize=(4, 3))
        axes.plot([0, 1], [0, 1], label="Baseline")
        axes.plot([0, 1], [0.2, 0.8], label="Proposed")
        axes.set_xlabel("Capacity (%)")
        axes.set_ylabel("Delay (ms)")
        axes.legend(frameon=False, loc="upper left")
        with tempfile.TemporaryDirectory() as directory:
            paths = finalize_figure(
                fig,
                Path(directory) / "figure_1",
                column="single",
                caption_title="Capacity reservation reduces delay",
                caption_text="Lines compare the baseline and proposed methods across capacity levels.",
            )
            self.assertTrue(all(path.exists() for path in paths))

    def test_missing_structure_is_rejected(self) -> None:
        """Missing labels, legend, and caption metadata must block export."""
        fig, axes = plt.subplots()
        axes.plot([0, 1], [0, 1], label="A")
        axes.plot([0, 1], [1, 0], label="B")
        codes = {issue.code for issue in inspect_figure(fig)}
        self.assertTrue({"X_LABEL_MISSING", "Y_LABEL_MISSING", "LEGEND_MISSING"} <= codes)
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(FigureQualityError):
                finalize_figure(fig, Path(directory) / "invalid")

    def test_panel_label_requires_nature_style(self) -> None:
        """Panel letters must be 8 pt bold and upright."""
        fig, axes = plt.subplots()
        axes.plot([0, 1], [0, 1])
        axes.set_xlabel("Time (s)")
        axes.set_ylabel("Value")
        axes.text(0.01, 0.99, "a", transform=axes.transAxes, va="top", fontsize=7)
        codes = {issue.code for issue in inspect_figure(fig)}
        self.assertIn("PANEL_LABEL_STYLE", codes)

    def test_legend_cannot_cover_data(self) -> None:
        """A legend intersecting a plotted line must be moved."""
        fig, axes = plt.subplots()
        axes.plot([0, 1], [0, 1], label="Series A")
        axes.plot([0, 1], [1, 0], label="Series B")
        axes.set_xlabel("Time (s)")
        axes.set_ylabel("Value")
        axes.legend(frameon=False, loc="center")
        codes = {issue.code for issue in inspect_figure(fig)}
        self.assertIn("LEGEND_DATA_OVERLAP", codes)

    def test_axes_title_is_rejected(self) -> None:
        """Titles belong in captions, not inside scientific artwork."""
        fig, axes = plt.subplots()
        axes.plot([0, 1], [0, 1])
        axes.set_xlabel("Time (s)")
        axes.set_ylabel("Value")
        axes.set_title("Result")
        codes = {issue.code for issue in inspect_figure(fig)}
        self.assertIn("AXES_TITLE", codes)


if __name__ == "__main__":
    unittest.main()
