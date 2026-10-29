'use strict';
let config, player, started = false;
const status = document.getElementById('status');
function report(type, message = '') { window.adhanPlayer.report(type, message); }
function fail(message) { status.textContent = message; report('error', message); }
document.getElementById('stop').addEventListener('click', () => window.adhanPlayer.stop());
window.onYouTubeIframeAPIReady = () => {
  player = new YT.Player('yt-player', {
    width: '640', height: '360', videoId: config.videoId,
    playerVars: { autoplay: 1, playsinline: 1, origin: location.origin, rel: 0 },
    events: {
      onReady: e => { e.target.setVolume(config.volume); e.target.playVideo(); },
      onStateChange: e => {
        if (e.data === YT.PlayerState.PLAYING) { started = true; status.textContent = 'Playing the full adhan'; report('playing'); }
        if (e.data === YT.PlayerState.ENDED) { status.textContent = 'Adhan complete'; report('ended'); }
      },
      onError: e => fail(`YouTube playback failed (code ${e.data}). Choose a local audio file for dependable playback.`),
      onAutoplayBlocked: () => fail('YouTube blocked automatic playback. Choose a local audio file for automatic adhan.')
    }
  });
};
window.adhanPlayer.getConfig().then(c => {
  config = c;
  document.getElementById('title').textContent = c.prayer === 'Test' ? 'Test your adhan' : c.isTest ? `Test your ${c.prayer} adhan` : `Time for ${c.prayer}`;
  if (c.mode === 'local') {
    document.getElementById('youtube').hidden = true;
    const audio = document.getElementById('audio');
    document.getElementById('detail').textContent = c.audioName + ' · full recording';
    audio.src = 'audio'; audio.volume = c.volume / 100;
    audio.addEventListener('playing', () => { started = true; status.textContent = 'Playing the full adhan'; report('playing'); });
    audio.addEventListener('ended', () => { status.textContent = 'Adhan complete'; report('ended'); });
    audio.addEventListener('error', () => fail('This audio file could not be played. Try an MP3 or WAV recording.'));
    audio.play().catch(e => fail('Audio could not start: ' + e.message));
  } else {
    document.getElementById('audio').hidden = true;
    document.getElementById('detail').textContent = 'Your selected YouTube recording · internet required';
    const script = document.createElement('script'); script.src = 'https://www.youtube.com/iframe_api';
    script.onerror = () => fail('YouTube is unreachable. Choose a local audio file for offline adhan.');
    document.head.append(script);
  }
  // Only loading has a timeout. Successful playback is never clipped.
  setTimeout(() => { if (!started) fail('Playback did not start within 45 seconds. Check your connection or choose a local recording.'); }, 45000);
}).catch(e => fail(e.message));
