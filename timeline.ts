import Database from 'better-sqlite3';
import { getTimeline, renderMarkdown, type TimelineInput } from './core';

// CLI demo: run getTimeline against the built events.sqlite and print a sample.
const db = new Database('events.sqlite', { readonly: true });

const demo: TimelineInput = {
  person: 'Ada Example',
  segments: [
    { label: 'Childhood', place: { name: 'Pueblo, Colorado, USA', lat: 38.2544, lng: -104.6091 }, start: '1902', end: '1921-06' },
    { label: 'Adulthood', place: { name: 'Chicago, Illinois, USA', lat: 41.8781, lng: -87.6298 }, start: '1921-06', end: '1954' },
  ],
};

const timeline = getTimeline(db, demo);
console.log(renderMarkdown(timeline));
console.log('\n--- Canonical JSON ---\n');
console.log(JSON.stringify(timeline, null, 2));
db.close();
