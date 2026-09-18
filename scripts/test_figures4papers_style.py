import tempfile
import unittest
import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

from figures4papers_style import (
    FigureStyle,
    apply_figures4papers_style,
    make_grouped_bar,
    save_style_preview,
)
from scientific_figure_guard import finalize_figure


class Figures4PapersStyleTest(unittest.TestCase):
    def test_style_preview_writes_png(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            output = Path(temp_dir) / "preview.png"
            generated = save_style_preview(output)
            self.assertTrue(generated.exists())
            self.assertGreater(generated.stat().st_size, 0)

    def test_style_is_compatible_with_figure_guard(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            apply_figures4papers_style(FigureStyle(font_size=7, axes_linewidth=0.7))
            fig, ax = plt.subplots(figsize=(3.5, 2.4))
            make_grouped_bar(
                ax,
                categories=["Base", "Stress", "Future"],
                series=[[0.62, 0.74, 0.81]],
                labels=["Proposed"],
                ylabel="Feasible ratio",
                annotate=True,
            )
            ax.set_xlabel("Scenario")
            _, _, report_path = finalize_figure(
                fig,
                Path(temp_dir) / "guarded.png",
                column="single",
                caption_title="Feasible routing ratio",
                caption_text="Feasible routing ratio under base, stress, and future demand scenarios.",
            )
            report = json.loads(report_path.read_text(encoding="utf-8"))
            self.assertEqual(report["status"], "PASS", report["issues"])


if __name__ == "__main__":
    unittest.main()
