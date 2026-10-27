export const helpTopics = {
  counting: {
    title: 'How sessions are counted',
    paragraphs: [
      'Faultline counts the first valid entry for each session in the selected UTC time range. Excluded sessions stay excluded.',
      'A conversion is the selected success event within 30 minutes of entry. Data must include that full 30-minute window.',
      'Check event names, dates, coverage, and missing values before saving the metric. Missing data stays marked as incomplete or unknown.'
    ]
  },
  controls: {
    title: 'How browser tests work',
    paragraphs: [
      'A browser test is tied to one build, approved site, and reviewed plan. If any of these change, review the test again.',
      'Reproducing the issue takes 12 checks. Testing the fix takes 18 checks.',
      'Review every required check. Failed, blocked, incomplete, cancelled, stale, and not-run checks do not pass.'
    ]
  },
  claims: {
    title: 'What the results mean',
    paragraphs: [
      'An observed link shows what changed in the selected data. It does not prove why it changed.',
      'A reproduced issue applies only to the tested builds, devices, environment, and checks. A tested fix applies only to the tested fix.',
      'Faultline does not claim that one tested issue caused the entire conversion drop.'
    ]
  }
} as const;

export function ContextHelp({topic}: {topic: keyof typeof helpTopics}) {
  const value = helpTopics[topic];
  return <details className="context-help"><summary>{value.title}</summary>{value.paragraphs.map(text => <p key={text}>{text}</p>)}</details>;
}
