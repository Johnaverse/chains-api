import { describe, it, expect } from 'vitest';
import { isPlannedClass, isPlannedEvent, isPlannedGroup } from '../../../src/domain/plannedWork.js';

const group = (...updates) => ({ updates, first: updates[0], latest: updates[updates.length - 1] });

describe('planned work vs incident', () => {
  it('counts a maintenance status as planned work', () => {
    expect(isPlannedEvent({ status: 'maintenance_scheduled' })).toBe(true);
  });

  it('counts a confidently classed software update as planned work under an incident status', () => {
    // Chainstack posted "Scheduled protocol upgrade (Polygon mainnet)" as `monitoring`.
    expect(isPlannedEvent({ status: 'monitoring', enrichment: { class: 'planned_software_update' } })).toBe(true);
    expect(isPlannedEvent({ status: 'resolved', enrichment: { class: 'planned_hard_fork' } })).toBe(true);
    expect(isPlannedEvent({ status: 'identified', enrichment: { class: 'urgent_software_fix' } })).toBe(true);
  });

  it('does not let a low-confidence class override the status', () => {
    expect(isPlannedClass({ class: 'planned_software_update', lowConfidence: true })).toBe(false);
    expect(isPlannedEvent({ status: 'investigating', enrichment: { class: 'planned_software_update', lowConfidence: true } })).toBe(false);
  });

  it('keeps an incident class an incident', () => {
    expect(isPlannedEvent({ status: 'investigating', enrichment: { class: 'provider_incident' } })).toBe(false);
  });

  it('reads a group by its newest confident classification', () => {
    // The update that moved a window to `resolved` is rarely the one the classifier read.
    const g = group(
      { status: 'identified', enrichment: { class: 'planned_software_update' } },
      { status: 'resolved' }
    );
    expect(isPlannedGroup(g)).toBe(true);
  });

  it('lets a later incident classification win over an earlier planned one', () => {
    const g = group(
      { status: 'identified', enrichment: { class: 'planned_software_update' } },
      { status: 'investigating', enrichment: { class: 'provider_incident' } }
    );
    expect(isPlannedGroup(g)).toBe(false);
  });

  it('skips low-confidence classifications when reading a group', () => {
    const g = group(
      { status: 'identified', enrichment: { class: 'planned_software_update' } },
      { status: 'monitoring', enrichment: { class: 'other', lowConfidence: true } }
    );
    expect(isPlannedGroup(g)).toBe(true);
  });
});
