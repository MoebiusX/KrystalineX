/**
 * Skill registry — imports all skills and exports them as an ordered array.
 *
 * To add a new telemetry source:
 *  1. Create a skill file in src/tools/ (see skill.ts for the interface)
 *  2. Import it below and add to the allSkills array
 */

import { skill as traces } from './tools/traces.js';
import { skill as metrics } from './tools/metrics.js';
import { skill as logs } from './tools/logs.js';
import { skill as elasticsearch } from './tools/elasticsearch.js';
import { skill as alertmanager } from './tools/alertmanager.js';
import { skill as zkProofs } from './tools/zk-proofs.js';
import { skill as system } from './tools/system.js';
import type { Skill } from './skill.js';

export const allSkills: Skill[] = [
  traces,
  metrics,
  logs,
  elasticsearch,
  alertmanager,
  zkProofs,
  system,
];
