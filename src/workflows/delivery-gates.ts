export type DeliveryReports = Record<'data' | 'citations' | 'quality' | 'scientific' | 'docx' | 'finalCitations' | 'finalScientific', string>;

/** A report's existence or a model verdict alone cannot certify submission readiness. */
export function deliveryGateStatuses(reports: DeliveryReports): Record<keyof DeliveryReports, boolean> {
  const passed = (text: string) => /(?:^|\n)(?:-\s*)?Status:\s*PASS\b/i.test(text)
    && !/(?:^|\n)(?:-\s*)?(?:Status|Manuscript gate):\s*BLOCKED\b/i.test(text);
  const reviewed = (text: string) => /(?:^|\n)Manuscript gate:\s*CLEAR\b/i.test(text)
    && !/(?:^|\n)Manuscript gate:\s*BLOCKED\b/i.test(text);
  const cited = (text: string) => {
    const total = Number(text.match(/总引用数:\s*(\d+)/)?.[1] || 0);
    const verified = Number(text.match(/已验证:\s*(\d+)/)?.[1] || 0);
    return total > 0 && verified === total && !/\[(?:not-found|mismatch|needs-review)\]/i.test(text);
  };
  return { data: passed(reports.data), citations: cited(reports.citations), quality: passed(reports.quality),
    scientific: reviewed(reports.scientific), docx: passed(reports.docx),
    finalCitations: passed(reports.finalCitations) && cited(reports.finalCitations), finalScientific: reviewed(reports.finalScientific) };
}
