import { type ItemType } from '../../state/gameState';
import { type ItemPropertyMetadata } from '../itemRegistry';

/** Static client-side definition for one item type's UI/config defaults. */
export type ItemTypeClientDefinition = {
  type: ItemType;
  label: string;
  tooltip?: string;
  editableProperties: string[];
  globalProperties: Record<string, string | number | boolean>;
  propertyOptions?: Record<string, string[]>;
  propertyMetadata?: Record<string, ItemPropertyMetadata>;
};

