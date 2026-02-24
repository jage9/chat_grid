import { type ItemType } from '../../state/gameState';
import { clockDefinition } from './clock';
import { diceDefinition } from './dice';
import { pianoDefinition } from './piano';
import { radioStationDefinition } from './radioStation';
import { wheelDefinition } from './wheel';
import { widgetDefinition } from './widget';
import { type ItemTypeClientDefinition } from './shared';

/** Ordered default client item definitions used before server UI definitions arrive. */
export const DEFAULT_ITEM_TYPE_DEFINITIONS: ItemTypeClientDefinition[] = [
  clockDefinition,
  diceDefinition,
  pianoDefinition,
  radioStationDefinition,
  wheelDefinition,
  widgetDefinition,
];

/** Default add-item menu ordering derived from local item definitions. */
export const DEFAULT_ITEM_TYPE_SEQUENCE: ItemType[] = DEFAULT_ITEM_TYPE_DEFINITIONS.map((definition) => definition.type);
