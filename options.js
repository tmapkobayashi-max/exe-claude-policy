const DEFAULTS = {
  chatworkToken: '',
  chatworkRoomId: '',
  thresholdEnabled: false,
  thresholdPercent: 80,
  thresholdMetric: 'allModels',
  dailyReportEnabled: false,
  morningTime: '09:00',
  eveningTime: '17:00',
  skipHoliday: true
};

const $ = (id) => document.getElementById(id);

function fieldsFromForm() {
  return {
    chatworkToken: $('chatworkToken').value.trim(),
    chatworkRoomId: $('chatworkRoomId').value.trim(),
    thresholdEnabled: $('thresholdEnabled').checked,
    thresholdPercent: Number($('thresholdPercent').value) || DEFAULTS.thresholdPercent,
    thresholdMetric: $('thresholdMetric').value,
    dailyReportEnabled: $('dailyReportEnabled').checked,
    morningTime: $('morningTime').value || DEFAULTS.morningTime,
    eveningTime: $('eveningTime').value || DEFAULTS.eveningTime,
    skipHoliday: $('skipHoliday').checked
  };
}

function fillForm(settings) {
  $('chatworkToken').value = settings.chatworkToken;
  $('chatworkRoomId').value = settings.chatworkRoomId;
  $('thresholdEnabled').checked = settings.thresholdEnabled;
  $('thresholdPercent').value = settings.thresholdPercent;
  $('thresholdMetric').value = settings.thresholdMetric;
  $('dailyReportEnabled').checked = settings.dailyReportEnabled;
  $('morningTime').value = settings.morningTime;
  $('eveningTime').value = settings.eveningTime;
  $('skipHoliday').checked = settings.skipHoliday;
}

async function load() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  fillForm({ ...DEFAULTS, ...stored });
}

function showResult(el, ok, message) {
  el.textContent = message;
  el.className = 'result ' + (ok ? 'ok' : 'ng');
}

$('saveBtn').addEventListener('click', async () => {
  const settings = fieldsFromForm();
  await chrome.storage.local.set(settings);
  chrome.runtime.sendMessage({ action: 'settingsUpdated' });
  showResult($('saveResult'), true, '保存しました');
});

$('testSendBtn').addEventListener('click', async () => {
  const { chatworkToken, chatworkRoomId } = fieldsFromForm();
  if (!chatworkToken || !chatworkRoomId) {
    showResult($('testResult'), false, 'トークンとルームIDを入力してください');
    return;
  }
  showResult($('testResult'), true, '送信中…');
  const response = await chrome.runtime.sendMessage({
    action: 'testChatworkMessage',
    chatworkToken,
    chatworkRoomId
  });
  if (response && response.success) {
    showResult($('testResult'), true, '送信できました（Chatworkを確認してください）');
  } else {
    showResult($('testResult'), false, '失敗：' + (response && response.error ? response.error : '不明なエラー'));
  }
});

load();
