// Web Worker: builds the new bytes of an audio file with its tags changed, off the main thread so the
// page stays responsive while many files are processed. It only computes; the main thread writes the result.
import { writeTags } from './index.js';

self.onmessage = async (e) => {
  const { id, file, model, opts } = e.data;
  try {
    const { blob, notes } = await writeTags(file, model, opts);
    self.postMessage({ id, blob, notes });
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) });
  }
};
