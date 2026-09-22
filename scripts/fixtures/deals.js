// A deal feed that is always fresh.
//
// brickdeal-website ships `deals.sample.json`, and it is the right fixture for
// that repo and the wrong one for this: eleven of its twelve records carry
// `_PLACEHOLDER` affiliate links and the twelfth was price-checked in July. Run
// this pipeline against it and every record is correctly refused, which proves
// the feed rules work and tests nothing else.
//
// So the dates are generated rather than written down. A committed fixture with
// a hardcoded `priceCheckedAt` is a test that passes for fourteen days and then
// starts failing for a reason that has nothing to do with the code — and the
// freshness rule is one of the things most worth having a test for.
//
// The set numbers are real, so a run with a BRICKSET_API_KEY actually exercises
// the lookup. The prices are invented and the piece counts are approximate;
// nothing here is a claim about anything, and none of it may be published —
// `unusable()` does not know this is a fixture, which is deliberate.

const DAY = 24 * 60 * 60 * 1000;
const iso = (now, daysAgo) => new Date(now - daysAgo * DAY).toISOString();

/**
 * @param {number} now  epoch millis the dates are generated relative to
 */
export function sampleDeals(now = Date.now()) {
  const d = (daysAgo) => ({ postedAt: iso(now, daysAgo), priceCheckedAt: iso(now, Math.min(daysAgo, 2)) });

  return [
    {
      productId: '1005012557193590',
      name: 'הארי פוטר | טירת הוגוורטס הגדולה',
      setId: '71043',
      pieces: 6020,
      price: 349.9,
      currency: 'ILS',
      stars: 4.8,
      theme: 'harry-potter',
      image: 'https://images.brickset.com/sets/images/71043-1.jpg',
      sourceImage: 'https://ae-pic-a1.aliexpress-media.com/kf/example-71043.jpg',
      link: 'https://s.click.aliexpress.com/e/_c3FmQwIP',
      ...d(1),
    },
    {
      productId: '1005012557193591',
      name: 'הארי פוטר | מגרש הקווידיץ׳',
      setId: '75956',
      pieces: 500,
      price: 79.4,
      currency: 'ILS',
      stars: 4.7,
      theme: 'harry-potter',
      image: 'https://images.brickset.com/sets/images/75956-1.jpg',
      link: 'https://s.click.aliexpress.com/e/_c3FmQwIQ',
      ...d(2),
    },
    {
      productId: '1005012557193592',
      name: 'הארי פוטר | רכבת הוגוורטס אקספרס',
      setId: '75955',
      pieces: 801,
      price: 118.0,
      currency: 'ILS',
      stars: 4.9,
      theme: 'harry-potter',
      image: 'https://images.brickset.com/sets/images/75955-1.jpg',
      link: 'https://s.click.aliexpress.com/e/_c3FmQwIR',
      ...d(3),
    },
    {
      productId: '1005012557193593',
      name: 'הארי פוטר | בית המרקחת של סנייפ',
      setId: '76431',
      pieces: 397,
      price: 62.5,
      currency: 'ILS',
      stars: 4.6,
      theme: 'harry-potter',
      image: 'https://images.brickset.com/sets/images/76431-1.jpg',
      link: 'https://s.click.aliexpress.com/e/_c3FmQwIS',
      ...d(4),
    },
    {
      productId: '1005012557193594',
      name: 'הארי פוטר | חדר הנחשים',
      setId: '76389',
      pieces: 1176,
      price: 164.0,
      currency: 'ILS',
      stars: 4.7,
      theme: 'harry-potter',
      image: 'https://images.brickset.com/sets/images/76389-1.jpg',
      link: 'https://s.click.aliexpress.com/e/_c3FmQwIT',
      ...d(5),
    },
    {
      productId: '1005012557193595',
      name: 'פרחים | זר ורדים',
      setId: '10328',
      pieces: 822,
      price: 43.89,
      currency: 'ILS',
      stars: 4.9,
      theme: 'flowers',
      image: 'https://images.brickset.com/sets/images/10328-1.jpg',
      sourceImage: 'https://ae-pic-a1.aliexpress-media.com/kf/example-10328.jpg',
      link: 'https://s.click.aliexpress.com/e/_c3FmQwIU',
      ...d(2),
    },
    {
      productId: '1005012557193596',
      name: 'פרחים | עץ בונסאי',
      setId: '10281',
      pieces: 878,
      price: 51.2,
      currency: 'ILS',
      stars: 4.8,
      theme: 'flowers',
      image: 'https://images.brickset.com/sets/images/10281-1.jpg',
      link: 'https://s.click.aliexpress.com/e/_c3FmQwIV',
      ...d(6),
    },
    {
      productId: '1005012557193597',
      name: 'רכבים | מכונית הזמן מחזרה לעתיד',
      setId: '10300',
      pieces: 1872,
      price: 78.13,
      currency: 'ILS',
      stars: 5.0,
      theme: 'vehicles',
      image: 'https://images.brickset.com/sets/images/10300-1.jpg',
      link: 'https://s.click.aliexpress.com/e/_c3FmQwIW',
      ...d(1),
    },
    {
      productId: '1005012557193598',
      name: 'רכבים | פרארי דייטונה SP3',
      setId: '42143',
      pieces: 3778,
      price: 289.0,
      currency: 'ILS',
      stars: 4.9,
      theme: 'vehicles',
      image: 'https://images.brickset.com/sets/images/42143-1.jpg',
      link: 'https://s.click.aliexpress.com/e/_c3FmQwIX',
      ...d(7),
    },
    {
      productId: '1005012557193599',
      name: 'ארכיטקטורה | מגדל אייפל',
      setId: '10307',
      pieces: 10001,
      price: 420.0,
      currency: 'ILS',
      stars: 4.9,
      theme: 'architecture',
      image: 'https://images.brickset.com/sets/images/10307-1.jpg',
      link: 'https://s.click.aliexpress.com/e/_c3FmQwIY',
      ...d(8),
    },
    {
      productId: '1005012557193600',
      name: 'ארכיטקטורה | הקולוסאום',
      setId: '10276',
      pieces: 9036,
      price: 395.0,
      currency: 'ILS',
      stars: 4.8,
      theme: 'architecture',
      image: 'https://images.brickset.com/sets/images/10276-1.jpg',
      link: 'https://s.click.aliexpress.com/e/_c3FmQwIZ',
      ...d(9),
    },
    {
      productId: '1005012557193601',
      name: 'דינוזאורים | דינוזאורים אדירים',
      setId: '31058',
      pieces: 174,
      price: 29.9,
      currency: 'ILS',
      stars: 4.5,
      theme: 'dinosaurs',
      image: 'https://images.brickset.com/sets/images/31058-1.jpg',
      link: 'https://s.click.aliexpress.com/e/_c3FmQwJA',
      ...d(3),
    },
    // A MOC with no set number: no Brickset lookup is possible, so this one can
    // never carry a comparison. Every deck built from this fixture should have
    // at least one, because the real feed does.
    {
      productId: '1005012557193602',
      name: 'פנטזיה | דרקון מים מותאם אישית',
      pieces: 645,
      price: 88.0,
      currency: 'ILS',
      stars: 4.4,
      theme: 'fantasy',
      image: 'https://ae-pic-a1.aliexpress-media.com/kf/example-moc.jpg',
      link: 'https://s.click.aliexpress.com/e/_c3FmQwJB',
      ...d(4),
    },
    // Refused on sight, and here on purpose: the fixture has to contain the
    // things the feed rules exist to catch, or a green run proves nothing.
    {
      productId: 'PLACEHOLDER-0099',
      name: 'עיר | תחנת משטרה',
      setId: '60316',
      pieces: 668,
      price: 55.0,
      currency: 'ILS',
      theme: 'city',
      image: 'https://images.brickset.com/sets/images/60316-1.jpg',
      link: 'https://s.click.aliexpress.com/e/_PLACEHOLDER0099',
      ...d(2),
    },
    {
      productId: '1005012557193603',
      name: 'חלל | מעבורת חלל',
      setId: '10283',
      pieces: 2354,
      price: 210.0,
      currency: 'ILS',
      theme: 'space',
      image: 'https://images.brickset.com/sets/images/10283-1.jpg',
      link: 'https://s.click.aliexpress.com/e/_c3FmQwJC',
      postedAt: iso(now, 40),
      priceCheckedAt: iso(now, 40), // stale: past the freshness floor
    },
    {
      productId: '1005012557193604',
      name: 'טכניק | מלגזה',
      setId: '42079',
      pieces: 592,
      price: 67.0,
      currency: 'ILS',
      theme: 'technic',
      image: 'https://images.brickset.com/sets/images/42079-1.jpg',
      link: 'https://s.click.aliexpress.com/e/_c3FmQwJD',
      dead: true, // taken down upstream
      ...d(1),
    },
  ];
}

export default sampleDeals;
