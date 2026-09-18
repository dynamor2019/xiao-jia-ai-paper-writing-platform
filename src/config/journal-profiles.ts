export interface JournalProfile {
  id: string;
  name: string;
  aliases: string[];
  targetWords: number;
  instructions: string[];
  officialUrls: string[];
}

const JOURNAL_PROFILES: JournalProfile[] = [
  {
    id: 'automation-in-construction',
    name: 'Automation in Construction',
    aliases: ['aic'],
    targetWords: 8000,
    instructions: [
      'Frame the contribution around information technologies across the building or infrastructure lifecycle.',
      'Connect AI novelty to a concrete construction, operation, maintenance, BIM, robotics, control, or facility-management problem.',
      'Report data provenance, baselines, ablations, uncertainty, and deployment constraints; avoid a generic algorithm paper.',
      'Use an unstructured factual abstract, author-year citations, highlights, a data-availability statement, and an AI-use declaration when applicable.',
    ],
    officialUrls: [
      'https://www.sciencedirect.com/journal/automation-in-construction/publish/guide-for-authors',
      'https://shop.elsevier.com/journals/automation-in-construction/0926-5805',
    ],
  },
  {
    id: 'advanced-engineering-informatics',
    name: 'Advanced Engineering Informatics',
    aliases: ['aei'],
    targetWords: 8000,
    instructions: [
      'Make knowledge representation, knowledge use, or engineering decision support central to the contribution.',
      'Do not present routine pattern recognition, optimization, or soft computing as sufficient novelty.',
      'Show why the method gains generality, power, or scalability in an engineering setting and compare against strong baselines.',
      'Use a factual abstract, author-year citations, highlights, a data-availability statement, and an AI-use declaration when applicable.',
    ],
    officialUrls: [
      'https://www.sciencedirect.com/journal/advanced-engineering-informatics/publish/guide-for-authors',
      'https://shop.elsevier.com/journals/advanced-engineering-informatics/1474-0346',
    ],
  },
  {
    id: 'journal-of-computing-in-civil-engineering',
    name: 'Journal of Computing in Civil Engineering',
    aliases: ['jcce'],
    targetWords: 7500,
    instructions: [
      'State the civil-engineering computing contribution and its practical relevance explicitly.',
      'Cover reproducibility, data availability, validation, limitations, and comparison with current civil-engineering methods.',
      'Use ASCE manuscript conventions and author-year references unless the current template specifies otherwise.',
      'Prepare a separate cover letter and check the current ASCE submission checklist before upload.',
    ],
    officialUrls: [
      'https://ascelibrary.org/journal/jccee5',
      'https://ascelibrary.org/author-center/journals-policies-ethics',
    ],
  },
  {
    id: 'computer-aided-civil-and-infrastructure-engineering',
    name: 'Computer-Aided Civil and Infrastructure Engineering',
    aliases: ['cacaie'],
    targetWords: 8000,
    instructions: [
      'Lead with a novel computational contribution that materially advances civil or infrastructure engineering.',
      'Use demanding external validation, competitive baselines, ablation studies, sensitivity analysis, and reproducibility evidence.',
      'Explain both methodological novelty and infrastructure impact; a routine application of an existing model is not enough.',
      'Follow the current Elsevier guide because the journal moved from Wiley to Elsevier in 2026.',
    ],
    officialUrls: [
      'https://www.sciencedirect.com/journal/computer-aided-civil-and-infrastructure-engineering/publish/guide-for-authors',
      'https://onlinelibrary.wiley.com/journal/14678667',
    ],
  },
  {
    id: 'building-and-environment',
    name: 'Building and Environment',
    aliases: ['bae'],
    targetWords: 7500,
    instructions: [
      'Tie AI to measurable building-environment outcomes such as indoor environmental quality, HVAC, controls, energy, or occupant response.',
      'Prioritize physical interpretation and rigorous measured or experimentally verified evidence over prediction accuracy alone.',
      'Report climate, building, sensor, occupancy, sampling, and validation conditions so results are transferable.',
      'Use a factual abstract, author-year citations, highlights, a data-availability statement, and an AI-use declaration when applicable.',
    ],
    officialUrls: [
      'https://www.sciencedirect.com/journal/building-and-environment/publish/guide-for-authors',
      'https://www.sciencedirect.com/journal/building-and-environment/about/aims-and-scope',
    ],
  },
  {
    id: 'energy-and-buildings',
    name: 'Energy and Buildings',
    aliases: ['eab'],
    targetWords: 7500,
    instructions: [
      'Center the paper on building energy performance, demand, controls, decarbonization, or coupled indoor-environment outcomes.',
      'Benchmark against engineering and data-driven baselines and quantify energy, peak-load, comfort, or emissions effects.',
      'State weather, climate zone, building type, system boundaries, tariffs or carbon factors, and generalization limits.',
      'Use a factual abstract, author-year citations, highlights, a data-availability statement, and an AI-use declaration when applicable.',
    ],
    officialUrls: [
      'https://www.sciencedirect.com/journal/energy-and-buildings/publish/guide-for-authors',
      'https://www.sciencedirect.com/journal/energy-and-buildings/about/aims-and-scope',
    ],
  },
  {
    id: 'journal-of-building-engineering',
    name: 'Journal of Building Engineering',
    aliases: ['jobe'],
    targetWords: 7500,
    instructions: [
      'Make the building-engineering problem, intervention, and measurable benefit explicit.',
      'For AI work, include engineering interpretation, robust validation, reproducibility, and practical implementation constraints.',
      'Describe the building, MEP system, operating conditions, data split, baselines, uncertainty, and limitations.',
      'Use a factual abstract, author-year citations, highlights, a data-availability statement, and an AI-use declaration when applicable.',
    ],
    officialUrls: [
      'https://www.sciencedirect.com/journal/journal-of-building-engineering/publish/guide-for-authors',
      'https://www.sciencedirect.com/journal/journal-of-building-engineering/about/aims-and-scope',
    ],
  },
  {
    id: 'science-and-technology-for-the-built-environment',
    name: 'Science and Technology for the Built Environment',
    aliases: ['stbe'],
    targetWords: 7000,
    instructions: [
      'Focus on HVAC&R, controls, fault detection, optimization, demand-side management, or validated building-system simulation.',
      'Connect methods to building-service engineering practice and report enough system detail for replication.',
      'Prepare an anonymized manuscript for double-anonymized review and remove identifying metadata and self-references.',
      'Use the current Taylor & Francis template and reference style at final formatting.',
    ],
    officialUrls: [
      'https://www.tandfonline.com/journals/uhvc21',
      'https://www.tandfonline.com/action/authorSubmission?show=instructions&journalCode=uhvc21',
    ],
  },
  {
    id: 'building-services-engineering-research-and-technology',
    name: 'Building Services Engineering Research and Technology',
    aliases: ['bsert'],
    targetWords: 8500,
    instructions: [
      'Keep a research paper near the journal working limit of about 9,000 words.',
      'Use an abstract of no more than 200 words, followed immediately by a Practical Application paragraph of no more than 100 words and 3-6 keywords.',
      'Use SAGE Vancouver references and prepare Statements and Declarations, CRediT roles, data availability, funding, conflicts, and a cover letter.',
      'Prepare figures at the stated resolution: 300 dpi images, 800 dpi line art, or 600 dpi combination artwork.',
    ],
    officialUrls: ['https://journals.sagepub.com/author-instructions/bse'],
  },
  {
    id: 'engineering-applications-of-artificial-intelligence',
    name: 'Engineering Applications of Artificial Intelligence',
    aliases: ['eaai'],
    targetWords: 8000,
    instructions: [
      'Make both the AI contribution and the real engineering application substantial.',
      'Use strong current baselines, ablations, statistical or uncertainty analysis, and evidence of generalization or operational value.',
      'Explain why the method advances engineering practice rather than merely applying a standard model to another dataset.',
      'Use a factual abstract, author-year citations, highlights, a data-availability statement, and an AI-use declaration when applicable.',
    ],
    officialUrls: [
      'https://www.sciencedirect.com/journal/engineering-applications-of-artificial-intelligence/publish/guide-for-authors',
      'https://www.sciencedirect.com/journal/engineering-applications-of-artificial-intelligence/about/aims-and-scope',
    ],
  },
  {
    id: 'ieee-transactions-on-automation-science-and-engineering',
    name: 'IEEE Transactions on Automation Science and Engineering',
    aliases: ['t-ase', 'tase'],
    targetWords: 7000,
    instructions: [
      'Frame the work as an automation-science contribution with a clear engineering system, formal method, and reproducible evaluation.',
      'Use the IEEE two-column template, numbered references, and a concise abstract; include a Note to Practitioners when required by the current template.',
      'Plan regular or review papers for 8-12 final typeset pages and communications for 6 pages; check current overlength charges before submission.',
      'Prepare a cover letter and explicitly discuss closely related work from the most recent two years.',
    ],
    officialUrls: [
      'https://www.ieee-ras.org/publications/t-ase/information-for-authors-t-ase/',
      'https://www.ieee-ras.org/publications/t-ase/information-for-authors-t-ase/t-ase-author-checklist-for-accepted-papers-final-manuscripts/',
    ],
  },
  {
    id: 'expert-systems-with-applications',
    name: 'Expert Systems with Applications',
    aliases: ['eswa'],
    targetWords: 8000,
    instructions: [
      'Present a non-trivial intelligent-system contribution with a clearly motivated application and decision value.',
      'Compare with strong recent methods, report ablations and uncertainty, and explain interpretability and deployment implications.',
      'Avoid a routine model-comparison paper or marginal accuracy gain without methodological or application insight.',
      'Use a factual abstract, author-year citations, highlights, a data-availability statement, and an AI-use declaration when applicable.',
    ],
    officialUrls: [
      'https://www.sciencedirect.com/journal/expert-systems-with-applications/publish/guide-for-authors',
      'https://www.sciencedirect.com/journal/expert-systems-with-applications/about/aims-and-scope',
    ],
  },
];

export function listJournalProfiles(): JournalProfile[] {
  return JOURNAL_PROFILES;
}

export function getJournalProfile(value?: string): JournalProfile | undefined {
  if (!value || value === 'general') return undefined;
  const normalized = value.trim().toLowerCase();
  return JOURNAL_PROFILES.find((profile) =>
    profile.id === normalized ||
    profile.name.toLowerCase() === normalized ||
    profile.aliases.includes(normalized)
  );
}

export function formatJournalInstructions(profile?: JournalProfile): string {
  if (!profile) return 'Target journal: not selected. Use a conventional evidence-driven research-paper structure.';
  return [
    `Target journal: ${profile.name}`,
    `Working manuscript length: about ${profile.targetWords} words (verify the live guide before submission).`,
    ...profile.instructions.map((instruction, index) => `${index + 1}. ${instruction}`),
    'Treat these as journal-specific writing constraints. Never invent missing study evidence to satisfy them.',
  ].join('\n');
}
