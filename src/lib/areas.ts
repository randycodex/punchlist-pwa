import type { Area, FacadeElevationDrawing, Project } from '@/types';

export type AreaTemplateKey = 'apartment' | 'commonArea' | 'facadeBrick' | 'facadeGFRC' | 'facadeEIFS' | 'halfBathroom' | 'notesOnly' | 'stairs' | 'vestibule' | 'lobby' | 'mailArea' | 'security';
export type AreaTypeKey =
  | 'amenity_space'
  | 'apartment_unit'
  | 'ats'
  | 'facade'
  | 'bike_storage'
  | 'corridor'
  | 'custom'
  | 'elevator_control_room'
  | 'egress'
  | 'electrical_closet'
  | 'electrical_room'
  | 'fire_pump'
  | 'hot_water'
  | 'it_closet'
  | 'it_room'
  | 'janitor'
  | 'laundry'
  | 'lobby'
  | 'mail_area'
  | 'mechanical'
  | 'multipurpose'
  | 'office'
  | 'parcel_room'
  | 'public_toilet'
  | 'refuse'
  | 'security'
  | 'stairs'
  | 'storage'
  | 'super_office'
  | 'trash_compactor'
  | 'vestibule'
  | 'water_room';

export type ApartmentUnitType = 'EFF' | '1BR' | '2BR' | '3BR';

export type FacadeOrientation = 'South' | 'North' | 'East' | 'West';
export type FacadeType = 'Bricks' | 'GFRC' | 'EIFS';

export const FACADE_ORIENTATIONS: FacadeOrientation[] = ['South', 'North', 'East', 'West'];
export const FACADE_TYPES: FacadeType[] = ['Bricks', 'GFRC', 'EIFS'];

export function buildFacadeLevelOptions(range?: { facadeLevelStart?: number; facadeLevelEnd?: number } | null): string[] {
  const start = range?.facadeLevelStart;
  const end = range?.facadeLevelEnd;
  if (
    typeof start !== 'number' ||
    typeof end !== 'number' ||
    !Number.isInteger(start) ||
    !Number.isInteger(end)
  ) {
    return [];
  }

  const min = Math.min(start, end);
  const max = Math.max(start, end);
  const levels: string[] = [];
  for (let level = min; level <= max; level += 1) {
    if (level === 0) continue;
    levels.push(`Level ${level}`);
  }
  return levels;
}

export type AreaTypeDefinition = {
  key: AreaTypeKey;
  label: string;
  templateKey: AreaTemplateKey;
  requiresUnitType?: boolean;
  requiresOrientation?: boolean;
  requiresFacadeType?: boolean;
  requiresCustomName?: boolean;
};

export type AreaFormValue = {
  areaTypeKey: AreaTypeKey;
  unitType: ApartmentUnitType | FacadeOrientation | '';
  customAreaName: string;
  areaNumber: string;
  facadeLevel: string;
  facadeLevelMode: '' | 'yes' | 'no';
  elevationDrawingId: string;
  pendingElevationDrawing?: FacadeElevationDrawing | null;
};

export const APARTMENT_UNIT_TYPES: ApartmentUnitType[] = ['EFF', '1BR', '2BR', '3BR'];

export const AREA_TYPE_DEFINITIONS: AreaTypeDefinition[] = [
  { key: 'amenity_space', label: 'Amenity Space', templateKey: 'commonArea' },
  { key: 'apartment_unit', label: 'Apartment / Unit', templateKey: 'apartment', requiresUnitType: true },
  { key: 'ats', label: 'ATS', templateKey: 'commonArea' },
  { key: 'bike_storage', label: 'Bike Storage', templateKey: 'commonArea' },
  { key: 'corridor', label: 'Corridor', templateKey: 'commonArea' },
  { key: 'custom', label: 'Custom', templateKey: 'commonArea', requiresCustomName: true },
  { key: 'egress', label: 'Egress', templateKey: 'commonArea' },
  { key: 'electrical_closet', label: 'Electrical Closet', templateKey: 'commonArea' },
  { key: 'facade', label: 'Facade', templateKey: 'commonArea', requiresOrientation: true, requiresFacadeType: true },
  { key: 'electrical_room', label: 'Electrical Room', templateKey: 'commonArea' },
  { key: 'elevator_control_room', label: 'Elevator Control Room', templateKey: 'commonArea' },
  { key: 'fire_pump', label: 'Fire Pump', templateKey: 'commonArea' },
  { key: 'hot_water', label: 'Hot Water', templateKey: 'commonArea' },
  { key: 'it_closet', label: 'IT Closet', templateKey: 'commonArea' },
  { key: 'it_room', label: 'IT Room', templateKey: 'commonArea' },
  { key: 'janitor', label: 'Janitor', templateKey: 'commonArea' },
  { key: 'laundry', label: 'Laundry', templateKey: 'commonArea' },
  { key: 'lobby', label: 'Lobby', templateKey: 'lobby' },
  { key: 'mail_area', label: 'Mail Area', templateKey: 'mailArea' },
  { key: 'mechanical', label: 'Mechanical', templateKey: 'commonArea' },
  { key: 'multipurpose', label: 'Multipurpose', templateKey: 'commonArea' },
  { key: 'office', label: 'Office', templateKey: 'commonArea' },
  { key: 'parcel_room', label: 'Parcel Room', templateKey: 'commonArea' },
  { key: 'public_toilet', label: 'Public Toilet', templateKey: 'commonArea' },
  { key: 'refuse', label: 'Refuse', templateKey: 'commonArea' },
  { key: 'security', label: 'Security', templateKey: 'security' },
  { key: 'stairs', label: 'Stairs', templateKey: 'stairs' },
  { key: 'storage', label: 'Storage', templateKey: 'commonArea' },
  { key: 'super_office', label: "Super's Office", templateKey: 'commonArea' },
  { key: 'trash_compactor', label: 'Trash Compactor', templateKey: 'commonArea' },
  { key: 'vestibule', label: 'Vestibule', templateKey: 'vestibule' },
  { key: 'water_room', label: 'Water Room', templateKey: 'commonArea' },
];

const definitionByKey = new Map<string, AreaTypeDefinition>(AREA_TYPE_DEFINITIONS.map((definition) => [definition.key, definition]));

export function getAreaTypeDefinition(areaTypeKey?: string): AreaTypeDefinition {
  return (areaTypeKey ? definitionByKey.get(areaTypeKey) : undefined) ?? definitionByKey.get('apartment_unit')!;
}

function normalizeAreaText(value: string): string {
  return value
    .toLowerCase()
    .replace(/['/]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function inferAreaTypeKeyFromName(name?: string): AreaTypeKey | undefined {
  const normalizedName = normalizeAreaText(name ?? '');
  if (!normalizedName) return undefined;

  if (
    normalizedName.startsWith('apartment ') ||
    normalizedName.startsWith('unit ') ||
    normalizedName.startsWith('apt ') ||
    normalizedName === 'apt'
  ) {
    return 'apartment_unit';
  }

  const matchedDefinition = AREA_TYPE_DEFINITIONS.find((definition) => {
    const normalizedLabel = normalizeAreaText(definition.label);
    return normalizedName === normalizedLabel || normalizedName.startsWith(`${normalizedLabel} `);
  });

  return matchedDefinition?.key;
}

export function resolveAreaTypeKey(area?: Pick<Area, 'areaTypeKey' | 'name'> | null): AreaTypeKey {
  return area?.areaTypeKey && definitionByKey.has(area.areaTypeKey)
    ? (area.areaTypeKey as AreaTypeKey)
    : inferAreaTypeKeyFromName(area?.name) ?? 'apartment_unit';
}

export function isApartmentArea(area?: Pick<Area, 'areaTypeKey' | 'name'> | null): boolean {
  return resolveAreaTypeKey(area) === 'apartment_unit';
}

export function buildAreaName(form: AreaFormValue): string {
  const definition = getAreaTypeDefinition(form.areaTypeKey);
  const baseName = definition.requiresCustomName ? form.customAreaName.trim() : definition.label;
  const areaNumber = form.areaNumber.trim();

  if (form.areaTypeKey === 'facade') {
    const facadeTypes = areaNumber.split(',').filter(Boolean);
    const facadeType = facadeTypes.length === 1 ? facadeTypes[0] : '';
    const facadeLevel = form.facadeLevel.includes(',') ? '' : form.facadeLevel.trim();
    return [baseName, form.unitType, facadeType, facadeLevel].filter(Boolean).join(' - ').trim();
  }

  if (form.areaTypeKey === 'apartment_unit') {
    return ['Unit', areaNumber, form.unitType].filter(Boolean).join(' - ').trim();
  }

  return [baseName, areaNumber].filter(Boolean).join(' - ').trim();
}

export function getDefaultAreaFormValue(): AreaFormValue {
  return {
    areaTypeKey: 'apartment_unit',
    unitType: '',
    customAreaName: '',
    areaNumber: '',
    facadeLevel: '',
    facadeLevelMode: '',
    elevationDrawingId: '',
    pendingElevationDrawing: null,
  };
}

export function splitFacadeLevels(value?: string) {
  return (value ?? '').split(',').map((level) => level.trim()).filter(Boolean);
}

export function getFacadeInspectionLevels(area?: Pick<Area, 'facadeLevel' | 'locations'> | null): string[] {
  const locationLevels =
    area?.locations
      .map((location) => location.name.trim())
      .filter((name) => /^Level\s*-?\d+\b/i.test(name)) ?? [];

  return locationLevels.length > 0 ? locationLevels : splitFacadeLevels(area?.facadeLevel);
}

export function getAreaFormValue(area?: Area | null): AreaFormValue {
  const areaTypeKey = resolveAreaTypeKey(area);
  const facadeLevels = areaTypeKey === 'facade' ? getFacadeInspectionLevels(area) : [];
  const unitType =
    areaTypeKey === 'facade'
      ? (FACADE_ORIENTATIONS.includes(area?.unitType as FacadeOrientation) ? (area?.unitType as FacadeOrientation) : '')
      : APARTMENT_UNIT_TYPES.includes(area?.unitType as ApartmentUnitType)
        ? (area?.unitType as ApartmentUnitType)
        : '';

  return {
    areaTypeKey,
    unitType,
    customAreaName: areaTypeKey === 'custom' ? area?.name ?? '' : '',
    areaNumber: area?.areaNumber ?? '',
    facadeLevel: areaTypeKey === 'facade' ? facadeLevels.join(',') : '',
    facadeLevelMode: areaTypeKey === 'facade' && facadeLevels.length > 0 ? 'yes' : 'no',
    elevationDrawingId: areaTypeKey === 'facade' ? area?.elevationDrawingId ?? '' : '',
    pendingElevationDrawing: null,
  };
}

export function cloneFacadeElevationDrawing(drawing: FacadeElevationDrawing): FacadeElevationDrawing {
  return {
    ...drawing,
    createdAt: new Date(drawing.createdAt),
    updatedAt: new Date(drawing.updatedAt),
  };
}

export function upsertFacadeElevationDrawing(
  project: Project,
  drawing?: FacadeElevationDrawing | null
): void {
  if (!drawing) return;

  const nextDrawing = cloneFacadeElevationDrawing(drawing);
  const drawings = project.facadeElevationDrawings ?? [];
  const existingIndex = drawings.findIndex((entry) => entry.id === nextDrawing.id);

  project.facadeElevationDrawings =
    existingIndex >= 0
      ? drawings.map((entry, index) => (index === existingIndex ? nextDrawing : entry))
      : [...drawings, nextDrawing];
}

export function getFacadeCreationLevels(form: AreaFormValue, facadeLevelOptions: string[]): string[] {
  if (form.areaTypeKey !== 'facade') return [form.facadeLevel.trim()].filter(Boolean);
  if (form.facadeLevelMode === 'yes') {
    const validLevels = new Set(facadeLevelOptions);
    return splitFacadeLevels(form.facadeLevel)
      .filter((level) => level && validLevels.has(level));
  }
  return [''];
}

export function getAreaCreationForms(form: AreaFormValue, facadeLevelOptions: string[]): AreaFormValue[] {
  if (form.areaTypeKey !== 'facade') return [form];

  const facadeTypes = form.areaNumber.split(',').filter(Boolean);
  if (facadeTypes.length === 0) return [];

  const facadeLevels = form.facadeLevelMode === 'yes' ? getFacadeCreationLevels(form, facadeLevelOptions) : [];
  if (form.facadeLevelMode === 'yes' && facadeLevels.length === 0) return [];

  return facadeTypes.map((facadeType) => ({
    ...form,
    areaNumber: facadeType,
    facadeLevel: facadeLevels.join(','),
  }));
}

function getAreaLevelSortValue(area: Pick<Area, 'facadeLevel' | 'name'>): number | null {
  const source = area.facadeLevel || area.name;
  const match = source.match(/\bLevel\s*(-?\d+)\b/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

function getAreaNameWithoutLevel(area: Pick<Area, 'facadeLevel' | 'name'>): string {
  return area.name.replace(/\s+-\s+Level\s*-?\d+\b/i, '').trim();
}

export function getLevelSortValue(name: string): number | null {
  const match = name.match(/^Level\s*(-?\d+)$/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

export function compareLevelNames(a: string, b: string): number {
  const levelA = getLevelSortValue(a);
  const levelB = getLevelSortValue(b);
  if (levelA !== null && levelB !== null && levelA !== levelB) {
    return levelA - levelB;
  }
  return 0;
}

export function compareAreaNames(a: Pick<Area, 'facadeLevel' | 'name'>, b: Pick<Area, 'facadeLevel' | 'name'>): number {
  const baseCompare = getAreaNameWithoutLevel(a).localeCompare(getAreaNameWithoutLevel(b));
  if (baseCompare !== 0) return baseCompare;

  const levelA = getAreaLevelSortValue(a);
  const levelB = getAreaLevelSortValue(b);
  if (levelA !== null && levelB !== null && levelA !== levelB) {
    return levelA - levelB;
  }

  return a.name.localeCompare(b.name);
}

type AreaTitleFields = Pick<Area, 'name' | 'areaTypeKey' | 'areaNumber' | 'unitType'>;

export function getAreaTitle(area: AreaTitleFields): string {
  if (!isApartmentArea(area)) return area.name;

  return ['Unit', area.areaNumber?.trim(), area.unitType?.trim()].filter(Boolean).join(' - ');
}

type AreaDisplayNameFields = Pick<Area, 'id' | 'name' | 'createdAt' | 'areaTypeKey' | 'areaNumber' | 'unitType'>;

export function getAreaDisplayNameMap(areas: AreaDisplayNameFields[]): Map<string, string> {
  const groupedByName = new Map<string, Array<AreaDisplayNameFields & { title: string }>>();

  for (const area of areas) {
    const title = getAreaTitle(area);
    const key = title.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
    const group = groupedByName.get(key);
    if (group) {
      group.push({ ...area, title });
    } else {
      groupedByName.set(key, [{ ...area, title }]);
    }
  }

  const displayNames = new Map<string, string>();
  for (const group of groupedByName.values()) {
    if (group.length === 1) {
      displayNames.set(group[0].id, group[0].title);
      continue;
    }

    const sortedGroup = [...group].sort((a, b) => {
      const createdCompare = a.createdAt.getTime() - b.createdAt.getTime();
      return createdCompare !== 0 ? createdCompare : a.id.localeCompare(b.id);
    });

    sortedGroup.forEach((area, index) => {
      displayNames.set(area.id, `${area.title} #${index + 1}`);
    });
  }

  return displayNames;
}

export function areaHasRecordedActivity(area: Area): boolean {
  return area.locations.some((location) =>
    location.items.some((item) =>
      item.checkpoints.some(
        (checkpoint) =>
          checkpoint.status !== 'pending' ||
          checkpoint.comments.trim().length > 0 ||
          Boolean(checkpoint.elevationMarker) ||
          checkpoint.photos.length > 0 ||
          (checkpoint.files?.length ?? 0) > 0
      )
    )
  );
}
