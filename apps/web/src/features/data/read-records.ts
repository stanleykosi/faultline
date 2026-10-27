import {type Investigation} from '../../api';
import {boundedResource} from '../../read-state';
import {type MetricRecord, type Snapshot} from './types';

export type RecordRead<T> = {status: 'ready'; value: T} | {status: 'unavailable'; error: Error};
type RecordListeners = {
  investigation: (state: RecordRead<Investigation>) => void;
  snapshots: (state: RecordRead<Snapshot[]>) => void;
  metrics: (state: RecordRead<MetricRecord[]>) => void;
};

export async function readRecords(base: string, signal: AbortSignal, listeners: RecordListeners): Promise<void> {
  async function read<T>(path: string, valid: (value: T) => boolean, unavailable: string, publish: (state: RecordRead<T>) => void) {
    try {
      const value = await boundedResource<T>(path, signal);
      if (!valid(value)) throw new Error(unavailable);
      if (!signal.aborted) publish({status: 'ready', value});
    } catch (cause) {
      if (!signal.aborted) publish({status: 'unavailable', error: cause instanceof Error ? cause : new Error(unavailable)});
    }
  }
  // Each response becomes visible independently; ancillary lists do not gate the case.
  await Promise.all([
    read<Investigation>(base, value => !!value && typeof value.id === 'string' && typeof value.title === 'string' && typeof value.question === 'string' && Number.isInteger(value.revision), 'Investigation metadata was unavailable.', listeners.investigation),
    read<Snapshot[]>(`${base}/snapshots`, Array.isArray, 'Snapshot metadata did not contain the expected list.', listeners.snapshots),
    read<MetricRecord[]>(`${base}/metrics`, Array.isArray, 'Metric metadata did not contain the expected list.', listeners.metrics)
  ]);
}
