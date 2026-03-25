const SERVER_URL = 'http://localhost:3210';

const ecSlider = document.getElementById('ec-verbosity');
const exSlider = document.getElementById('ex-verbosity');
const ecVal = document.getElementById('ec-val');
const exVal = document.getElementById('ex-val');
const concurrency = document.getElementById('concurrency');
const statusLink = document.getElementById('status-link');

// Load saved settings
chrome.storage.local.get(['ecVerbosity', 'exVerbosity', 'concurrency'], (data) => {
  if (data.ecVerbosity != null) { ecSlider.value = data.ecVerbosity; ecVal.textContent = data.ecVerbosity; }
  if (data.exVerbosity != null) { exSlider.value = data.exVerbosity; exVal.textContent = data.exVerbosity; }
  if (data.concurrency != null) { concurrency.value = data.concurrency; }
});

ecSlider.addEventListener('input', () => {
  ecVal.textContent = ecSlider.value;
  chrome.storage.local.set({ ecVerbosity: parseInt(ecSlider.value) });
});

exSlider.addEventListener('input', () => {
  exVal.textContent = exSlider.value;
  chrome.storage.local.set({ exVerbosity: parseInt(exSlider.value) });
});

concurrency.addEventListener('change', () => {
  const val = parseInt(concurrency.value);
  chrome.storage.local.set({ concurrency: val });
  // Notify server of concurrency change
  fetch(`${SERVER_URL}/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ concurrency: val })
  }).catch(() => {});
});

statusLink.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: `${SERVER_URL}/status` });
});
