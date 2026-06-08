import { Area, Location, Item, Checkpoint } from '@/types';
import { createLocation, createItem, createCheckpoint } from './db';
import { getAreaTypeDefinition, resolveAreaTypeKey } from './areas';

interface TemplateItem {
  name: string;
  checkpoints: string[];
}

interface TemplateLocation {
  name: string;
  items: TemplateItem[];
  sectionLabel?: string;
}

const facadeBrickTemplate: TemplateLocation[] = [
  {
    name: 'Masonry Units',
    items: [{ name: 'Masonry Units', checkpoints: ['Cracking', 'Spalling', 'Staining', 'Erosion'] }],
  },
  {
    name: 'Mortar Joints',
    items: [{ name: 'Mortar Joints', checkpoints: ['Cracking', 'Erosion', 'Efflorescence', 'Repointing'] }],
  },
  {
    name: 'Structure',
    items: [{ name: 'Structure', checkpoints: ['Bulging', 'Lintels', 'Ties', 'Expansion Joints'] }],
  },
  {
    name: 'Waterproofing',
    items: [{ name: 'Waterproofing', checkpoints: ['Flashing', 'Weepholes', 'Sealants', 'Infiltration'] }],
  },
];

const facadeGFRCTemplate: TemplateLocation[] = [
  {
    name: 'Window',
    items: [{ name: 'Window', checkpoints: ['Sill', 'Jamb', 'Head', 'Glass', 'Frame', 'Caulking', 'Stain', 'Dirty'] }],
  },
  {
    name: 'Panels',
    items: [
      {
        name: 'Panels',
        checkpoints: ['Cracking', 'Crazing', 'Delamination', 'Spalling', 'Loose', 'Screw/Rivet', 'Fading', 'Coating', 'Stain', 'Dirty'],
      },
    ],
  },
  {
    name: 'Joints',
    items: [{ name: 'Joints', checkpoints: ['Sealants', 'Compression', 'Adhesion', 'Backer Rod'] }],
  },
];

const facadeEIFSTemplate: TemplateLocation[] = [
  {
    name: 'Finish Coat',
    items: [{ name: 'Finish Coat', checkpoints: ['Cracking', 'Impact', 'Staining', 'Fading'] }],
  },
  {
    name: 'Base Coat',
    items: [{ name: 'Base Coat', checkpoints: ['Delamination', 'Mesh', 'Hollow', 'Separation'] }],
  },
  {
    name: 'Terminations',
    items: [{ name: 'Terminations', checkpoints: ['Flashing', 'Perimeter', 'Weep Screed', 'Penetrations'] }],
  },
  {
    name: 'Moisture',
    items: [{ name: 'Moisture', checkpoints: ['Pooling', 'Saturation', 'Drainage', 'Infiltration'] }],
  },
];

const commonAreaItems: TemplateItem[] = [
  { name: 'Ceiling', checkpoints: ['Paint', 'Clean'] },
  { name: 'Wall', checkpoints: ['Paint', 'Clean'] },
  { name: 'Base', checkpoints: ['Surface', 'Clean'] },
  { name: 'Floor', checkpoints: ['Paint', 'Clean'] },
  { name: 'Light Fixture', checkpoints: ['Operational', 'Bulb', 'Cleaning'] },
  { name: 'Door', checkpoints: ['Hardware', 'Closer', 'Paint', 'Threshold'] },
];

const vestibuleTemplate: TemplateLocation[] = [
  {
    name: 'Vestibule',
    items: [
      ...commonAreaItems,
      { name: 'Building Entry Door', checkpoints: ['Hardware', 'Closer', 'Paint', 'Sweep', 'Stop', 'FireRating Label'] },
      { name: 'Wall Paint', checkpoints: ['Walls', 'Ceiling'] },
      { name: 'Tile', checkpoints: ['Chipping', 'Grout', 'Caulk', 'Clean'] },
      { name: 'Sprinkler', checkpoints: ['Cover', 'Clean', 'Flush'] },
      { name: 'Signage', checkpoints: ['Condition', 'Legible', 'Secure'] },
      { name: 'Intercom', checkpoints: ['Operational', 'Square', 'Clean'] },
      { name: 'Flooring', checkpoints: ['Adhesion', 'Edges', 'Joints', 'Finish'] },
      { name: 'Outlets', checkpoints: ['Operational', 'Cover', 'Clean', 'Square'] },
      { name: 'Ventilation', checkpoints: ['Cover', 'Clean', 'Square'] },
      { name: 'Clean', checkpoints: ['Yes'] },
    ],
  },
];

const lobbyTemplate: TemplateLocation[] = [
  {
    name: 'Lobby',
    items: [
      ...commonAreaItems,
      { name: 'Lobby Entry Door', checkpoints: ['Hardware', 'Closer', 'Paint', 'Sweep', 'Stop', 'FireRating Label'] },
      { name: 'Mech Closet', checkpoints: ['Door', 'Paint', 'Clean'] },
      { name: 'Closet', checkpoints: ['Door', 'Paint', 'Shelving', 'Clean'] },
      { name: 'Paint', checkpoints: ['Walls', 'Ceiling'] },
      { name: 'Tile', checkpoints: ['Chipping', 'Grout', 'Caulk', 'Clean'] },
      { name: 'Sprinkler', checkpoints: ['Cover', 'Clean', 'Flush'] },
      { name: 'Signage', checkpoints: ['Condition', 'Legible', 'Secure'] },
      { name: 'Fire Extinguisher', checkpoints: ['Mounted', 'Charged', 'Accessible'] },
      { name: 'Flooring', checkpoints: ['Adhesion', 'Edges', 'Joints', 'Finish'] },
      { name: 'Outlets', checkpoints: ['Operational', 'Cover', 'Clean', 'Square'] },
      { name: 'Ventilation', checkpoints: ['Cover', 'Clean', 'Square'] },
      { name: 'Elev. 1 Entrance', checkpoints: ['Door', 'Frame', 'Threshold', 'Indicator'] },
      { name: 'Elev. 2 Entrance', checkpoints: ['Door', 'Frame', 'Threshold', 'Indicator'] },
      { name: 'Clean', checkpoints: ['Yes'] },
    ],
  },
];

const mailAreaTemplate: TemplateLocation[] = [
  {
    name: 'Mail Area',
    items: [
      ...commonAreaItems,
      { name: 'Mail Boxes', checkpoints: ['Doors', 'Locks', 'Labels', 'Condition'] },
      { name: 'Tile', checkpoints: ['Chipping', 'Grout', 'Caulk', 'Clean'] },
      { name: 'Paint', checkpoints: ['Walls', 'Ceiling'] },
      { name: 'Sprinkler', checkpoints: ['Cover', 'Clean', 'Flush'] },
      { name: 'Signage', checkpoints: ['Condition', 'Legible', 'Secure'] },
      { name: 'Flooring', checkpoints: ['Adhesion', 'Edges', 'Joints', 'Finish'] },
      { name: 'Outlets', checkpoints: ['Operational', 'Cover', 'Clean', 'Square'] },
      { name: 'Ventilation', checkpoints: ['Cover', 'Clean', 'Square'] },
      { name: 'Clean', checkpoints: ['Yes'] },
      { name: 'General', checkpoints: ['Condition', 'Clean'] },
    ],
  },
];

const securityTemplate: TemplateLocation[] = [
  {
    name: 'Security',
    items: [
      ...commonAreaItems,
      { name: 'Entry Door', checkpoints: ['Hardware', 'Closer', 'Paint', 'Stop', 'FireRating Label'] },
      { name: 'Closet Door', checkpoints: ['Hardware', 'Closer', 'Paint', 'Stop'] },
      { name: 'Closet', checkpoints: ['Paint', 'Shelving', 'Clean'] },
      { name: 'Paint', checkpoints: ['Walls', 'Ceiling'] },
      { name: 'Intercom', checkpoints: ['Operational', 'Square', 'Clean'] },
      { name: 'Sprinkler', checkpoints: ['Cover', 'Clean', 'Flush'] },
      { name: 'Elec. Panel', checkpoints: ['Door', 'Clean', 'Flush'] },
      { name: 'Security Window', checkpoints: ['Glazing', 'Frame', 'Locks', 'Caulk'] },
      { name: 'Flooring', checkpoints: ['Adhesion', 'Edges', 'Joints', 'Finish'] },
      { name: 'Outlets', checkpoints: ['Operational', 'Cover', 'Clean', 'Square'] },
      { name: 'A/C', checkpoints: ['Operational', 'Thermostat', 'Cover', 'Clean'] },
      { name: 'Windows', checkpoints: ['Operational', 'Locks', 'Caulking', 'Frame'] },
      { name: 'Clean', checkpoints: ['Yes'] },
    ],
  },
];

const stairsTemplate: TemplateLocation[] = [
  {
    name: 'Stairs',
    items: [
      { name: 'Wall', checkpoints: ['Paint', 'Clean'] },
      { name: 'Ceiling', checkpoints: ['Paint', 'Clean'] },
      { name: 'Stair / Landing', checkpoints: ['Paint', 'Surface', 'Clean'] },
      { name: 'Railing', checkpoints: ['Welding', 'Paint', 'Clean'] },
      { name: 'Light Fixture', checkpoints: ['Operational', 'Bulb', 'Cleaning'] },
      { name: 'Door', checkpoints: ['Hardware', 'Closer', 'Paint', 'Threshold'] },
    ],
  },
];

function createLivingAreaItems(includeIntercom: boolean): TemplateItem[] {
  return [
    { name: 'Paint', checkpoints: ['Walls', 'Ceiling'] },
    { name: 'Flooring', checkpoints: ['Adhesion', 'Edges', 'Joints', 'Finish'] },
    { name: 'Base', checkpoints: ['Paint', 'Flush', 'Corners', 'Caulk'] },
    { name: 'PTAC / PTHP Enclosure', checkpoints: ['Operational', 'Thermostat', 'Cover', 'Edges', 'Clean'] },
    ...(includeIntercom ? [{ name: 'Intercom', checkpoints: ['Operational', 'Square', 'Clean'] }] : []),
    { name: 'Light Fixture', checkpoints: ['Operational', 'Bulb', 'Clean'] },
    { name: 'Outlets', checkpoints: ['TV/Phone/Elec', 'Cover', 'Square', 'Clean', 'CATV/Ant Label'] },
    { name: 'Window', checkpoints: ['Operational', 'Locks', 'Limiter', 'Caulking', 'Frame'] },
    { name: 'Window Sill / Jamb / Head', checkpoints: ['Flush', 'Caulk', 'Clean'] },
    { name: 'Sprinkler', checkpoints: ['Cover', 'Clean', 'Flush'] },
    { name: 'Clean', checkpoints: ['Yes'] },
  ];
}

const corridorItems: TemplateItem[] = [
  { name: 'Closet', checkpoints: ['Paint', 'Shelving', 'Rod', 'Ceiling'] },
  { name: 'Paint', checkpoints: ['Walls', 'Ceiling'] },
  { name: 'Flooring', checkpoints: ['Adhesion', 'Edges', 'Joints', 'Finish'] },
  { name: 'Ceiling', checkpoints: ['Paint', 'Clean'] },
  { name: 'Light Fixtures', checkpoints: ['Operational', 'Bulb', 'Clean'] },
];

const bathroomItems: TemplateItem[] = [
  { name: 'Door', checkpoints: ['Finish', 'Hardware operation', 'Stop', 'Frame Paint'] },
  { name: 'Saddle / Threshold', checkpoints: ['Level', '< 1/2" Transition'] },
  { name: 'Paint', checkpoints: ['Walls', 'Ceiling'] },
  { name: 'Wall Tile', checkpoints: ['Chipping', 'Grout', 'Edging', 'Caulk', 'Square'] },
  { name: 'Floor Tile', checkpoints: ['Chipping', 'Grout', 'Edging', 'Caulk', 'Square'] },
  { name: 'Toilet', checkpoints: ['18" Ctr to Wall?', 'Seat', 'Flush', 'Caulk', 'ADA-Comp'] },
  { name: 'Lavatory', checkpoints: ['Faucets', 'Caulked', 'Mount', 'Escutcheon', '15" O.C ?'] },
  { name: 'Tub / Shower', checkpoints: ['Shower Faucet', 'Tub Spout', 'Controls', 'Caulk', 'Escutcheon', 'Grab Bars', 'Rod', 'Curtain'] },
  { name: 'Med Cabinet', checkpoints: ['Shelves', 'Mirror', 'Clean'] },
  { name: 'Accessories', checkpoints: ['Towel Bar', 'Tooth Brush Holder', 'TP Holder', 'Robe Hook', 'Square'] },
  { name: 'Vanity Light', checkpoints: ['Operational', 'Bulb', 'Centered', 'Clean'] },
  { name: 'Ceiling Light', checkpoints: ['Operational', 'Bulb', 'Clean'] },
  { name: 'Outlets', checkpoints: ['Operational', 'Cover', 'Clean', 'Square', 'GFI'] },
  { name: 'Ventilation', checkpoints: ['Cover', 'Clean', 'Square'] },
  { name: 'Clean', checkpoints: ['Yes'] },
];

const apartmentBaseTemplate: TemplateLocation[] = [
  {
    name: 'Entry / Foyer',
    items: [
      { name: 'Entry Door', checkpoints: ['Paint', 'Closer', 'Chime', 'Peep', 'Stop', 'Sweep', 'Hardware operation', 'Latch', 'Swing', 'FireRating Label'] },
      { name: 'Saddle / Threshold', checkpoints: ['Level', '< 1/2" Transition'] },
      { name: 'Paint', checkpoints: ['Walls', 'Ceiling'] },
      { name: 'Flooring', checkpoints: ['Adhesion', 'Edges', 'Joints', 'Finish'] },
      { name: 'Base', checkpoints: ['Paint', 'Flush', 'Corners', 'Caulk'] },
      { name: 'Closet 1 Door', checkpoints: ['Finish', 'Magnetic Catch', 'Hardware', 'Stop', 'Frame Paint'] },
      { name: 'Closet 1 Interior', checkpoints: ['Paint', 'Shelving', 'Rod', 'Ceiling'] },
      { name: 'Verizon / Cable', checkpoints: ['Boxes in place', 'Door', 'Clean', 'Caulk'] },
      { name: 'Closet 2 Door', checkpoints: ['Finish', 'Magnetic Catch', 'Hardware', 'Stop', 'Frame Paint'] },
      { name: 'Closet 2 Interior', checkpoints: ['Paint', 'Shelving', 'Rod', 'Ceiling'] },
      { name: 'General Paint', checkpoints: ['Wall', 'Ceiling'] },
      { name: 'Light Fixture', checkpoints: ['Operational', 'Bulb', 'Clean', 'Square'] },
      { name: 'Sprinkler', checkpoints: ['Cover', 'Clean', 'Flush'] },
      { name: 'Overall Clean', checkpoints: ['Yes'] },
      { name: 'Elec. Panel', checkpoints: ['Door', 'Clean', 'Flush'] },
      { name: 'Outlets', checkpoints: ['Operational', 'Cover', 'Clean', 'Square'] },
    ],
  },
  {
    name: 'Bathroom',
    items: bathroomItems,
  },
  {
    name: 'Kitchen',
    items: [
      { name: 'Floor Transition', checkpoints: ['Level'] },
      { name: 'Cabinets', checkpoints: ['Hardware', 'Silencer', 'Finish', 'Shelves', 'Kickplate'] },
      { name: 'Counter', checkpoints: ['Finish', 'Caulk', 'Clean'] },
      { name: 'Outlets', checkpoints: ['Operational', 'Cover', 'Clean', 'Square', 'GFI'] },
      { name: 'Paint', checkpoints: ['Walls', 'Ceiling'] },
      { name: 'Wall Tile', checkpoints: ['Chipping', 'Grout', 'Edging', 'Caulk', 'Square'] },
      { name: 'Sink', checkpoints: ['Operational', 'Strainer', 'Clean', 'Edging'] },
      { name: 'Sprinkler', checkpoints: ['Cover', 'Clean', 'Flush'] },
      { name: 'Light Fixture', checkpoints: ['Operational', 'Bulb', 'Clean'] },
      { name: 'Ventilation', checkpoints: ['Cover', 'Square', 'Clean'] },
      { name: 'Range', checkpoints: ['Operational', 'Back Cover', 'Level', 'Clean'] },
      { name: 'Refrigerator', checkpoints: ['Operational', 'Level', 'Clean', 'Shelves', 'Swing'] },
      { name: 'Convection Oven', checkpoints: ['Operational', 'Level', 'Clean'] },
      { name: 'Conv. Oven Outlet', checkpoints: ['Cover', 'Clean', 'Square', 'GFI', 'Hole in Cabinet for Oven Plug'] },
      { name: 'Clean', checkpoints: ['Yes'] },
    ],
  },
];

function getApartmentTemplate(unitType?: Area['unitType']): TemplateLocation[] {
  const template: TemplateLocation[] = [...apartmentBaseTemplate];

  if (unitType === '3BR') {
    template.push({
      name: 'Half Bathroom',
      items: bathroomItems.filter((item) => item.name !== 'Tub / Shower'),
    });
    template.push({
      name: 'Corridor',
      items: corridorItems,
    });
  }

  if (unitType === 'EFF') {
    template.push({
      name: 'Living/Bedroom',
      items: createLivingAreaItems(true),
    });
    return template;
  }

  template.push({
    name: 'Living',
    items: createLivingAreaItems(true),
  });

  const bedroomCount = unitType === '3BR' ? 3 : unitType === '2BR' ? 2 : 1;

  for (let index = 0; index < bedroomCount; index += 1) {
    template.push({
      name: bedroomCount === 1 ? 'Bedroom' : `Bedroom ${index + 1}`,
      items: createLivingAreaItems(false),
    });
  }

  return template;
}

function getLocationMatchNames(name: string): string[] {
  switch (name) {
    case 'Living':
      return ['Living', 'Living/Bedroom'];
    case 'Living/Bedroom':
      return ['Living/Bedroom', 'Living'];
    case 'Bedroom':
      return ['Bedroom', 'Bedroom 1'];
    case 'Bedroom 1':
      return ['Bedroom 1', 'Bedroom'];
    default:
      return [name];
  }
}

function findMatchingLocation(
  locations: Location[],
  targetName: string,
  usedLocationIds: Set<string>
): Location | undefined {
  const candidateNames = getLocationMatchNames(targetName);
  for (const candidateName of candidateNames) {
    const match = locations.find(
      (location) => !usedLocationIds.has(location.id) && location.name === candidateName
    );
    if (match) return match;
  }
  return undefined;
}

function reconcileCheckpoints(
  item: Item,
  existingCheckpoints: Checkpoint[],
  templateCheckpointNames: string[],
  now: Date
): Checkpoint[] {
  const usedCheckpointIds = new Set<string>();

  return templateCheckpointNames.map((checkpointName, checkpointIndex) => {
    const existingCheckpoint = existingCheckpoints.find(
      (checkpoint) => !usedCheckpointIds.has(checkpoint.id) && checkpoint.name === checkpointName
    );
    const checkpoint =
      existingCheckpoint ?? createCheckpoint(item.id, checkpointName, checkpointIndex);

    usedCheckpointIds.add(checkpoint.id);
    checkpoint.itemId = item.id;
    checkpoint.name = checkpointName;
    checkpoint.sortOrder = checkpointIndex;
    checkpoint.updatedAt = now;

    return checkpoint;
  });
}

function reconcileItems(
  location: Location,
  existingItems: Item[],
  templateItems: TemplateItem[],
  now: Date
): Item[] {
  const usedItemIds = new Set<string>();

  return templateItems.map((templateItem, itemIndex) => {
    const existingItem = existingItems.find(
      (item) => !usedItemIds.has(item.id) && item.name === templateItem.name
    );
    const item = existingItem ?? createItem(location.id, templateItem.name, itemIndex);

    usedItemIds.add(item.id);
    item.locationId = location.id;
    item.name = templateItem.name;
    item.sortOrder = itemIndex;
    item.updatedAt = now;
    item.checkpoints = reconcileCheckpoints(
      item,
      existingItem?.checkpoints ?? [],
      templateItem.checkpoints,
      now
    );

    return item;
  });
}

function populateArea(
  area: Area,
  templateLocations: TemplateLocation[],
  options?: { preserveExisting?: boolean }
): void {
  const now = new Date();
  const existingLocations = options?.preserveExisting ? area.locations : [];
  const usedLocationIds = new Set<string>();

  area.locations = templateLocations.map((templateLocation, locationIndex) => {
    const existingLocation = findMatchingLocation(
      existingLocations,
      templateLocation.name,
      usedLocationIds
    );
    const location =
      existingLocation ?? createLocation(area.id, templateLocation.name, locationIndex);

    usedLocationIds.add(location.id);
    location.areaId = area.id;
    location.name = templateLocation.name;
    location.sortOrder = locationIndex;
    location.updatedAt = now;
    location.sectionLabel = templateLocation.sectionLabel;
    location.items = reconcileItems(
      location,
      existingLocation?.items ?? [],
      templateLocation.items,
      now
    );

    return location;
  });

}

function getFacadeTemplateLocations(area: Area): TemplateLocation[] {
  const facadeTypes = (area.areaNumber ?? '').split(',').filter(Boolean);
  if (facadeTypes.length === 0) return [];

  const typeTemplateMap: Record<string, TemplateLocation[]> = {
    Bricks: facadeBrickTemplate,
    GFRC: facadeGFRCTemplate,
    EIFS: facadeEIFSTemplate,
  };

  const merged: TemplateLocation[] = [];
  for (const facadeType of facadeTypes) {
    const locations = typeTemplateMap[facadeType] ?? [];
    locations.forEach((location) => {
      merged.push({ ...location, sectionLabel: facadeTypes.length > 1 ? facadeType : undefined });
    });
  }

  return merged;
}

function populateFacadeArea(area: Area): boolean {
  const facadeTemplateLocations = getFacadeTemplateLocations(area);
  if (facadeTemplateLocations.length === 0) return false;

  const facadeLevels = (area.facadeLevel ?? '').split(',').map((level) => level.trim()).filter(Boolean);
  if (facadeLevels.length === 0) {
    populateArea(area, facadeTemplateLocations);
    return true;
  }

  populateArea(
    area,
    facadeLevels.map((level) => ({
      name: level.replace(/^Level\s+/i, ''),
      items: facadeTemplateLocations.flatMap((location) => location.items),
    }))
  );
  return true;
}

export function applyTemplateToArea(area: Area): void {
  const definition = getAreaTypeDefinition(resolveAreaTypeKey(area));

  if (definition.templateKey === 'apartment') {
    populateArea(area, getApartmentTemplate(area.unitType));
    return;
  }

  if (definition.templateKey === 'stairs') {
    populateArea(area, stairsTemplate);
    return;
  }

  if (definition.templateKey === 'vestibule') {
    populateArea(area, vestibuleTemplate);
    return;
  }

  if (definition.templateKey === 'lobby') {
    populateArea(area, lobbyTemplate);
    return;
  }

  if (definition.templateKey === 'mailArea') {
    populateArea(area, mailAreaTemplate);
    return;
  }

  if (definition.templateKey === 'security') {
    populateArea(area, securityTemplate);
    return;
  }

  if (definition.templateKey === 'commonArea') {
    if (area.areaTypeKey === 'facade') {
      if (populateFacadeArea(area)) return;
    }
    populateArea(area, [{ name: area.name, items: commonAreaItems }]);
    return;
  }

  area.locations = [];
}
