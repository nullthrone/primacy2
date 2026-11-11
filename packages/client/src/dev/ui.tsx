import { render } from 'preact';
import { signal } from '@preact/signals';

const n = signal(0);
function Probe() {
  return <div style="color:#7fe9ff;font:20px sans-serif" onClick={() => n.value++}>probe {n}</div>;
}
render(<Probe />, document.getElementById('ui')!);
(window as unknown as { __ready: boolean }).__ready = true;
