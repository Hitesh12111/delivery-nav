// All user-facing copy lives here so a Hinglish (or Hindi) set can be added
// later as another key alongside `en`.
export const STRINGS = {
  en: {
    brand: 'DELIVERY NAV',
    routeReady: 'Delivery route ready',
    tower: 'Tower',
    flat: 'Flat',
    floor: 'Floor',
    viaService: 'via service road',
    enterThrough: 'Enter through {gate}',
    compare: 'Compare with resident route',
    legendDelivery: 'Delivery route',
    legendResident: 'Resident route',
    start: 'Start navigation',
    youAreHere: 'You are here',
    serviceEntrance: 'Service entrance',
    residentEntrance: 'Resident lobby',
    notForDelivery: 'Not for deliveries',
    chainGate: 'Gate 2',
    chainRoad: 'Service road',
    chainEntrance: 'Service entrance',
    chainLift: 'Service lift',
    chainFloor: 'Floor {floor}',
    chainFlat: 'Flat {flat}',
    replay: 'Replay',
    comingNext: 'Navigation steps are next in the build',
  },
};

let lang = 'en';
export const setLang = (l) => { if (STRINGS[l]) lang = l; };
export function t(key, vars = {}) {
  const s = STRINGS[lang][key] ?? STRINGS.en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
}
