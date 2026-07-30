// ===================== Shared blurb classifiers =====================
// `ingest-dump.ts` picks a category from an item's P31 types and then discards
// them, so the events table cannot distinguish a university from a war. The one
// place the distinction survives is the Wikidata English description stored in
// events.blurb, which both score.ts and rescope-foundings.ts already mine.
//
// This module exists so those two files share one pattern set instead of drifting
// apart. It is pure -- no DB, no side effects -- so either script can import it.

/**
 * Wikidata descriptions are noun phrases that lead with the subject's class:
 * "university in Toronto, Ontario, Canada", "for-profit college based in the
 * United States". Everything after the first comma is almost always location or
 * qualification, so restricting the match to the head phrase is what separates
 * "school in Cook County" (an institution) from "school shooting in Cook County"
 * (an event that merely mentions one).
 */
function headPhrase(blurb: string): string {
  return blurb.toLowerCase().split(',')[0].trim().slice(0, 80);
}

/**
 * Incident vocabulary vetoes the institution test outright. A disaster AT an
 * institution is history and must keep its full reach -- capping the Bath School
 * disaster or a hospital fire to a 300 km radius would be a worse error than the
 * one this module fixes.
 */
const INCIDENT: RegExp[] = [
  /\b(disaster|catastrophe|tragedy)\b/,
  /\b(shooting|massacre|murder|killing|assassination)\b/,
  /\b(fire|explosion|blast|bombing|arson)\b/,
  /\b(attack|siege|raid|invasion|battle|war|uprising|revolt|riot)\b/,
  /\b(collapse|crash|wreck|sinking|derailment)\b/,
  /\b(epidemic|pandemic|outbreak|famine)\b/,
  /\b(strike|walkout|lockout|protest|demonstration|boycott)\b/,
  /\b(scandal|controversy|trial|lawsuit|bankruptcy|closure|dissolution)\b/,
  /\b(flood|earthquake|hurricane|tornado|cyclone|eruption|avalanche|landslide)\b/,
];

/**
 * Institution nouns, deliberately CONSERVATIVE.
 *
 * Omitted on purpose: "organization", "intergovernmental organization",
 * "association", "society", "institute", "foundation", "political party",
 * "trade union". Those cover the United Nations, the Red Cross, NATO, the Royal
 * Society and every party founding in the corpus -- rows whose founding genuinely
 * was national or global news. A false demotion there costs more than leaving a
 * few minor bodies at their ladder scope, so they are left alone.
 */
const INSTITUTION: RegExp[] = [
  // education
  /\b(university|college|polytechnic|academy|seminary|conservatory|gymnasium)\b/,
  /\b(school|schools)\b/,
  // health
  /\b(hospital|infirmary|clinic|sanatorium|asylum|medical cent(er|re))\b/,
  // culture and knowledge
  /\b(museum|art gallery|library|archive|observatory|planetarium|botanical garden|arboretum|zoo|aquarium)\b/,
  /\b(theatre|theater|opera house|concert hall|cinema|stadium|arena|racecourse)\b/,
  // commerce
  /\b(company|corporation|firm|manufacturer|conglomerate|retailer|chain|brand)\b/,
  /\b(bank|insurer|brewery|distillery|winery|foundry|mill|factory|shipyard|refinery)\b/,
  /\b(airline|railway company|shipping line|bus company|publisher|publishing house|record label|film studio)\b/,
  // media
  /\b(newspaper|magazine|periodical|tabloid|broadcaster)\b/,
  /\b(television (channel|station|network)|radio (channel|station|network))\b/,
  // sport
  /\b((association )?football club|sports club|sports team|baseball team|basketball team|ice hockey team|cricket club|rugby club)\b/,
  // religion
  /\b(church|cathedral|basilica|chapel|abbey|monastery|convent|priory|mosque|synagogue|temple|parish|diocese)\b/,
  // hospitality and retail premises
  /\b(hotel|inn|restaurant|casino|department store|shopping (mall|centre|center))\b/,
];

/**
 * True when the blurb describes a standing institution rather than something that
 * happened. Used to cap scope: an institution's founding is local or regional news
 * however famous the institution later became.
 */
export function isInstitution(blurb: string | null | undefined): boolean {
  if (!blurb) return false;
  const b = blurb.toLowerCase();
  if (INCIDENT.some((re) => re.test(b))) return false;
  const head = headPhrase(blurb);
  return INSTITUTION.some((re) => re.test(head));
}
