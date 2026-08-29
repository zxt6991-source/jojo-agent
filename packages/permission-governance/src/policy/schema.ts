import {
  PermissionPolicyDocumentSchema,
  PermissionRuleSchema
} from '@desktop-agent/contracts';
import { z } from 'zod';

export const PermissionModeSchema = z.enum(['ask', 'auto', 'yolo']);
export { PermissionPolicyDocumentSchema, PermissionRuleSchema };
