export const site = {
  title: 'Relay',
  author: 'Relay',
  lang: 'en',
  description: 'An AI newsroom.',
  favicon: '/favicon.svg',
  theme: { appearance: 'auto' as const },
};

export function formatDate(date: Date) {
  return date.toISOString().slice(0, 10);
}
