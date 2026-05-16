
    /* ═══════════════════════════════════════════════
       GLOBALS
    ═══════════════════════════════════════════════ */
    let myUserId = null;
    let myProfile = null;
    let myServers = [];
    let activeServer = null;

    // Voice chat state
    let localStream = null;
    let peerConnections = {}; // peerId -> RTCPeerConnection
    let isMuted = false;
    let inVoice = false;
    let voiceChannel = null;    // Supabase channel for signaling
    let presenceChannel = null; // Supabase channel for presence
    let roomChatChannel = null; // Supabase channel for room chat
    let roomMessages = [];
    let voiceParticipants = {}; // userId -> {profile, speaking, muted}

    // ICE servers (STUN + public TURN for NAT traversal)
    const ICE_SERVERS = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun4.l.google.com:19302' },
      { urls: 'stun:openrelay.metered.ca:80' },
      {
        urls: 'turn:openrelay.metered.ca:80',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: 'turn:openrelay.metered.ca:443',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: 'turn:openrelay.metered.ca:443?transport=tcp',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      }
    ];

    /* ═══════════════════════════════════════════════
       INIT
    ═══════════════════════════════════════════════ */
    document.addEventListener('DOMContentLoaded', async () => {
      await ZenAuth.initSupabase();
      const user = await ZenAuth.getUserAsync();
      // bypassed
      myUserId = user.id;

      const client = ZenAuth.getSupabaseClient();
      const { data: prof } = await client.from('profiles').select('*').eq('id', myUserId).single();
      myProfile = prof;

      const av = document.getElementById('navAvatar');
      if (av) {
        av.style.background = prof?.avatar_color || '#1A1A1A';
        av.textContent = prof?.avatar_emoji || '';
      }

      ZenAuth.onAuthStateChange(e => { if (e === 'SIGNED_OUT') window.location.href = 'login.html'; });

      await loadServers();

      // Auto-open join modal if URL contains ?join=CODE (from shareable invite link)
      const urlParams = new URLSearchParams(location.search);
      const autoJoinCode = urlParams.get('join');
      if (autoJoinCode) {
        history.replaceState({}, '', location.pathname);
        openCreateModal();
        switchCJ('join');
        document.getElementById('joinCode').value = autoJoinCode.toUpperCase().slice(0, 6);
        showToast('Invite code auto-filled — click "Join Server" to continue!', 'success');
      }
    });

    /* ═══════════════════════════════════════════════
       LOAD SERVERS
    ═══════════════════════════════════════════════ */
    async function loadServers() {
      const client = ZenAuth.getSupabaseClient();
      const { data: memberships } = await client
        .from('server_members')
        .select('server_id, role')
        .eq('user_id', myUserId);

      if (!memberships?.length) {
        document.getElementById('srvList').innerHTML = `<div style="padding:24px 16px;text-align:center;color:var(--ink-faint);font-size:.8rem;line-height:1.6">No servers yet.<br>Create one or join with an invite code!</div>`;
        return;
      }

      const ids = memberships.map(m => m.server_id);
      const { data: servers } = await client.from('servers').select('*').in('id', ids);
      myServers = servers || [];

      renderServerList();
    }

    function renderServerList() {
      const el = document.getElementById('srvList');
      if (!myServers.length) {
        el.innerHTML = `<div style="padding:24px 16px;text-align:center;color:var(--ink-faint);font-size:.8rem;line-height:1.6">No servers yet.<br>Create one or join with an invite code!</div>`;
        return;
      }
      el.innerHTML = myServers.map(s => `
    <div class="srv-item ${activeServer?.id === s.id ? 'active' : ''}" onclick="openServer('${s.id}')">
      <div class="srv-icon">${s.icon_emoji || ''}</div>
      <div class="srv-item-info">
        <div class="srv-item-name">${esc(s.name)}</div>
        <div class="srv-item-sub">${esc(s.description || 'No description')}</div>
      </div>
    </div>
  `).join('');
    }

    /* ═══════════════════════════════════════════════
       OPEN SERVER ROOM
    ═══════════════════════════════════════════════ */
    async function openServer(serverId) {
      // Leave voice if in another room
      if (inVoice) await leaveVoice();

      // Cleanup old channels
      const client = ZenAuth.getSupabaseClient();
      if (presenceChannel) { client.removeChannel(presenceChannel); presenceChannel = null; }
      if (roomChatChannel) { client.removeChannel(roomChatChannel); roomChatChannel = null; }

      activeServer = myServers.find(s => s.id === serverId);
      if (!activeServer) return;

      renderServerList();

      // Update header
      document.getElementById('roomIcon').textContent = activeServer.icon_emoji || '';
      document.getElementById('roomName').textContent = activeServer.name;
      document.getElementById('srvEmpty').style.display = 'none';
      document.getElementById('roomView').style.display = 'flex';

      // Load chat history
      roomMessages = [];
      document.getElementById('rchatMsgs').innerHTML = '';
      const { data: msgs } = await client
        .from('server_messages')
        .select('*, profiles:sender_id(display_name, username, avatar_emoji, avatar_color)')
        .eq('server_id', serverId)
        .order('created_at', { ascending: true })
        .limit(80);

      (msgs || []).forEach(m => appendRchatMsg(m, false));
      scrollRchat();

      // Subscribe to new messages
      roomChatChannel = client.channel(`server_chat:${serverId}`)
        .on('postgres_changes', {
          event: 'INSERT', schema: 'public', table: 'server_messages',
          filter: `server_id=eq.${serverId}`
        }, async (payload) => {
          const msg = payload.new;
          // Fetch sender profile
          const { data: prof } = await client.from('profiles').select('display_name, username, avatar_emoji, avatar_color').eq('id', msg.sender_id).single();
          msg.profiles = prof;
          appendRchatMsg(msg, true);
        })
        .subscribe();

      // Presence channel for "online" count
      presenceChannel = client.channel(`server_presence:${serverId}`, { config: { presence: { key: myUserId } } });
      presenceChannel
        .on('presence', { event: 'sync' }, () => { updateOnlineCount(); })
        .subscribe(async (status) => {
          if (status === 'SUBSCRIBED') {
            await presenceChannel.track({ userId: myUserId, name: myProfile?.display_name || myProfile?.username });
          }
        });

      // Always re-fetch fresh server data so invite_code is up-to-date
      try {
        const { data: freshSrv } = await client
          .from('servers').select('invite_code, owner_id').eq('id', serverId).single();
        if (freshSrv?.invite_code) {
          activeServer.invite_code = freshSrv.invite_code;
          const idx = myServers.findIndex(s => s.id === activeServer.id);
          if (idx !== -1) myServers[idx].invite_code = freshSrv.invite_code;
        }
      } catch (e) { }

      // Show leave button for non-owners, show invite code badge for owners
      const isOwner = activeServer.owner_id === myUserId;
      document.getElementById('leaveRoomBtn').style.display = isOwner ? 'none' : '';

      // Show the owner's invite code inline in the header
      const ownerBadge = document.getElementById('ownerCodeBadge');
      const headerCodeText = document.getElementById('headerCodeText');
      if (isOwner) {
        // Ensure the server has an invite code; generate one if missing
        if (!activeServer.invite_code) {
          const code = generateCode();
          const { error: codeErr } = await client.from('servers').update({ invite_code: code }).eq('id', activeServer.id);
          if (!codeErr) {
            activeServer.invite_code = code;
            const idx = myServers.findIndex(s => s.id === activeServer.id);
            if (idx !== -1) myServers[idx].invite_code = code;
          } else {
            // Update failed — try one more fetch in case another session set it
            const { data: retry } = await client.from('servers').select('invite_code').eq('id', activeServer.id).single();
            if (retry?.invite_code) activeServer.invite_code = retry.invite_code;
          }
        }
        headerCodeText.textContent = activeServer.invite_code || '----';
        ownerBadge.style.display = 'flex';
      } else {
        ownerBadge.style.display = 'none';
      }
    }

    function updateOnlineCount() {
      if (!presenceChannel) return;
      const state = presenceChannel.presenceState();
      const count = Object.keys(state).length;
      document.getElementById('roomSub').innerHTML = `<span class="online-dot"></span>${count} online`;
    }

    /* ═══════════════════════════════════════════════
       ROOM CHAT
    ═══════════════════════════════════════════════ */
    function appendRchatMsg(msg, animate) {
      const area = document.getElementById('rchatMsgs');
      const isMe = msg.sender_id === myUserId;
      const prof = msg.profiles || {};
      const name = prof.display_name || prof.username || 'Unknown';
      const color = prof.avatar_color || '#1A1A1A';
      const emoji = prof.avatar_emoji || '';
      const time = new Date(msg.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

      const div = document.createElement('div');
      div.className = 'rchat-msg';
      if (animate) div.style.animation = 'fadeIn .2s ease';
      div.innerHTML = `
    <div class="rchat-msg-avatar" style="background:${color}">${emoji}</div>
    <div class="rchat-msg-body">
      <div class="rchat-msg-meta">
        <span class="rchat-msg-name">${esc(name)}</span>
        <span class="rchat-msg-time">${time}</span>
      </div>
      <div class="rchat-msg-text">${escHtml(msg.body)}</div>
    </div>
  `;
      area.appendChild(div);
      if (animate) scrollRchat();
    }

    function appendSystemMsg(text) {
      const area = document.getElementById('rchatMsgs');
      const div = document.createElement('div');
      div.className = 'rchat-system-msg';
      div.textContent = text;
      area.appendChild(div);
      scrollRchat();
    }

    function scrollRchat() {
      const a = document.getElementById('rchatMsgs');
      a.scrollTop = a.scrollHeight;
    }

    function handleRchatKey(e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendRchatMsg(); }
    }

    async function sendRchatMsg() {
      if (!activeServer) return;
      const inp = document.getElementById('rchatInput');
      const body = inp.value.trim();
      if (!body) return;
      inp.value = '';

      const client = ZenAuth.getSupabaseClient();
      await client.from('server_messages').insert({
        server_id: activeServer.id,
        sender_id: myUserId,
        body
      });
    }

    /* ═══════════════════════════════════════════════
       VOICE CHAT (WebRTC)
    ═══════════════════════════════════════════════ */
    async function joinVoice() {
      if (!activeServer) return;

      setVoiceStatus('connecting', 'Connecting…');

      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          showToast('Your browser does not support voice chat. Try Chrome or Firefox.', 'error');
          setVoiceStatus('', 'Not connected');
          return;
        }
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      } catch (err) {
        console.error('getUserMedia error:', err);
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
          showToast('Microphone access denied. Please allow mic access and try again.', 'error');
        } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
          showToast('No microphone found. Please connect a microphone and try again.', 'error');
        } else if (err.name === 'NotReadableError') {
          showToast('Microphone is in use by another app. Close it and try again.', 'error');
        } else if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
          showToast('Voice chat requires HTTPS. Please open this page over a secure connection.', 'error');
        } else {
          showToast('Could not access microphone: ' + err.message, 'error');
        }
        setVoiceStatus('', 'Not connected');
        return;
      }

      inVoice = true;
      document.getElementById('joinVoiceBtn').parentElement.style.display = 'none';
      document.getElementById('inVoiceControls').style.display = 'flex';

      // Add self to participants
      voiceParticipants[myUserId] = { profile: myProfile, muted: false, speaking: false, isMe: true };
      renderParticipants();

      // Setup voice activity detection
      setupVAD();

      // Subscribe to signaling channel
      const client = ZenAuth.getSupabaseClient();
      voiceChannel = client.channel(`voice:${activeServer.id}`, { config: { presence: { key: myUserId } } });

      voiceChannel
        .on('presence', { event: 'sync' }, async () => {
          const state = voiceChannel.presenceState();
          const peers = Object.keys(state).filter(k => k !== myUserId);

          // Connect to new peers
          for (const peerId of peers) {
            if (!peerConnections[peerId]) {
              await createPeerConnection(peerId, true);
            }
          }

          // Update participant list from presence
          const presences = Object.values(state).flat();
          for (const p of presences) {
            if (p.userId && !voiceParticipants[p.userId]) {
              voiceParticipants[p.userId] = { profile: { display_name: p.name, avatar_emoji: p.emoji, avatar_color: p.color }, muted: p.muted || false, speaking: false };
            } else if (p.userId) {
              voiceParticipants[p.userId].muted = p.muted || false;
            }
          }
          renderParticipants();
        })
        .on('presence', { event: 'join' }, async ({ key, newPresences }) => {
          const p = newPresences[0];
          if (key !== myUserId) {
            voiceParticipants[key] = { profile: { display_name: p.name, avatar_emoji: p.emoji, avatar_color: p.color }, muted: p.muted || false, speaking: false };
            renderParticipants();
            appendSystemMsg(`${p.name || 'Someone'} joined voice`);
            // Initiator creates the offer
            if (!peerConnections[key]) {
              await createPeerConnection(key, true);
            }
          }
        })
        .on('presence', { event: 'leave' }, ({ key }) => {
          if (key !== myUserId) {
            const name = voiceParticipants[key]?.profile?.display_name || 'Someone';
            delete voiceParticipants[key];
            cleanupPeer(key);
            renderParticipants();
            appendSystemMsg(`${name} left voice`);
          }
        })
        .on('broadcast', { event: 'signal' }, async ({ payload }) => {
          if (payload.to !== myUserId) return;
          const from = payload.from;

          if (payload.type === 'offer') {
            if (!peerConnections[from]) await createPeerConnection(from, false);
            const pc = peerConnections[from];
            await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            voiceChannel.send({ type: 'broadcast', event: 'signal', payload: { from: myUserId, to: from, type: 'answer', sdp: answer } });
          } else if (payload.type === 'answer') {
            const pc = peerConnections[from];
            if (pc) await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
          } else if (payload.type === 'ice') {
            const pc = peerConnections[from];
            if (pc && payload.candidate) {
              try { await pc.addIceCandidate(new RTCIceCandidate(payload.candidate)); } catch (e) { }
            }
          } else if (payload.type === 'mute_update') {
            if (voiceParticipants[from]) {
              voiceParticipants[from].muted = payload.muted;
              renderParticipants();
            }
          }
        })
        .subscribe(async (status) => {
          if (status === 'SUBSCRIBED') {
            await voiceChannel.track({
              userId: myUserId,
              name: myProfile?.display_name || myProfile?.username || 'You',
              emoji: myProfile?.avatar_emoji || '',
              color: myProfile?.avatar_color || '#1A1A1A',
              muted: false
            });
            setVoiceStatus('connected', 'Connected');
            appendSystemMsg('You joined voice');
          }
        });
    }

    async function createPeerConnection(peerId, isInitiator) {
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      peerConnections[peerId] = pc;

      // Add local tracks
      if (localStream) {
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
      }

      // When we get remote audio
      pc.ontrack = (event) => {
        const stream = event.streams[0];
        let audio = document.getElementById(`audio-${peerId}`);
        if (!audio) {
          audio = document.createElement('audio');
          audio.id = `audio-${peerId}`;
          audio.autoplay = true;
          document.getElementById('audioContainer').appendChild(audio);
        }
        audio.srcObject = stream;
        setupRemoteVAD(stream, peerId);
      };

      // ICE candidates
      pc.onicecandidate = (event) => {
        if (event.candidate && voiceChannel) {
          voiceChannel.send({ type: 'broadcast', event: 'signal', payload: { from: myUserId, to: peerId, type: 'ice', candidate: event.candidate } });
        }
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed') { cleanupPeer(peerId); }
      };

      if (isInitiator) {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        voiceChannel?.send({ type: 'broadcast', event: 'signal', payload: { from: myUserId, to: peerId, type: 'offer', sdp: offer } });
      }

      return pc;
    }

    function cleanupPeer(peerId) {
      if (peerConnections[peerId]) {
        peerConnections[peerId].close();
        delete peerConnections[peerId];
      }
      const audio = document.getElementById(`audio-${peerId}`);
      if (audio) audio.remove();
    }

    async function leaveVoice() {
      if (!inVoice) return;
      inVoice = false;

      // Stop local stream
      if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }

      // Cleanup all peers
      Object.keys(peerConnections).forEach(cleanupPeer);
      peerConnections = {};

      // Leave Supabase channel
      const client = ZenAuth.getSupabaseClient();
      if (voiceChannel) { await voiceChannel.untrack(); client.removeChannel(voiceChannel); voiceChannel = null; }

      // Remove self from participants
      delete voiceParticipants[myUserId];
      renderParticipants();

      setVoiceStatus('', 'Not connected');
      document.getElementById('joinVoiceBtn').parentElement.style.display = '';
      document.getElementById('inVoiceControls').style.display = 'none';

      isMuted = false;
      updateMuteUI();
      appendSystemMsg('You left voice');
    }

    function toggleMute() {
      if (!localStream) return;
      isMuted = !isMuted;
      localStream.getAudioTracks().forEach(t => { t.enabled = !isMuted; });
      updateMuteUI();

      if (voiceParticipants[myUserId]) {
        voiceParticipants[myUserId].muted = isMuted;
        renderParticipants();
      }

      // Broadcast mute state
      voiceChannel?.send({ type: 'broadcast', event: 'signal', payload: { from: myUserId, to: '__all__', type: 'mute_update', muted: isMuted } });
      // Also update presence
      voiceChannel?.track({ userId: myUserId, name: myProfile?.display_name || myProfile?.username || 'You', emoji: myProfile?.avatar_emoji || '', color: myProfile?.avatar_color || '#1A1A1A', muted: isMuted });
    }

    function updateMuteUI() {
      const btn = document.getElementById('muteBtn');
      if (isMuted) {
        btn.classList.add('muted');
        btn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 005.12 2.12M15 9.34V4a3 3 0 00-5.94-.6"/><path d="M17 16.95A7 7 0 015 12v-2m14 0v2a7 7 0 01-.11 1.23M12 19v4M8 23h8"/></svg> Unmute`;
      } else {
        btn.classList.remove('muted');
        btn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2a3 3 0 003 3v2a3 3 0 01-3 3 3 3 0 01-3-3V5a3 3 0 013-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2M12 19v3M8 22h8"/></svg> Mute`;
      }
    }

    /* Voice Activity Detection */
    let audioContext = null;
    function setupVAD() {
      if (!localStream) return;
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const source = audioContext.createMediaStreamSource(localStream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      let speakingTimer = null;

      function check() {
        analyser.getByteFrequencyData(data);
        const vol = data.reduce((a, b) => a + b, 0) / data.length;
        const speaking = vol > 15 && !isMuted;
        if (voiceParticipants[myUserId]) {
          const was = voiceParticipants[myUserId].speaking;
          voiceParticipants[myUserId].speaking = speaking;
          if (was !== speaking) renderParticipants();
        }
        if (inVoice) requestAnimationFrame(check);
      }
      requestAnimationFrame(check);
    }

    function setupRemoteVAD(stream, peerId) {
      if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
      try {
        const source = audioContext.createMediaStreamSource(stream);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);

        function check() {
          analyser.getByteFrequencyData(data);
          const vol = data.reduce((a, b) => a + b, 0) / data.length;
          const speaking = vol > 10;
          if (voiceParticipants[peerId]) {
            const was = voiceParticipants[peerId].speaking;
            voiceParticipants[peerId].speaking = speaking;
            if (was !== speaking) renderParticipants();
          }
          if (peerConnections[peerId]) requestAnimationFrame(check);
        }
        requestAnimationFrame(check);
      } catch (e) { }
    }

    function renderParticipants() {
      const grid = document.getElementById('participantsGrid');
      const entries = Object.entries(voiceParticipants);
      if (!entries.length) {
        grid.innerHTML = `<div class="no-participants"><svg viewBox="0 0 24 24"><path d="M12 2a3 3 0 003 3v2a3 3 0 01-3 3 3 3 0 01-3-3V5a3 3 0 013-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2M12 19v3M8 22h8"/></svg><p>No one is in voice yet.<br/>Join the channel to start talking!</p></div>`;
        return;
      }

      grid.innerHTML = entries.map(([uid, p]) => {
        const prof = p.profile || {};
        const name = uid === myUserId ? (prof.display_name || prof.username || 'You') + ' (You)' : (prof.display_name || prof.username || 'Unknown');
        const color = prof.avatar_color || '#1A1A1A';
        const emoji = prof.avatar_emoji || '';
        return `
      <div class="participant-card ${p.speaking ? 'speaking' : ''} ${p.muted ? 'muted' : ''}">
        <div class="participant-avatar" style="background:${color}">
          ${emoji}
          ${p.muted ? `<div class="participant-muted-icon"><svg viewBox="0 0 24 24"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 005.12 2.12M15 9.34V4a3 3 0 00-5.94-.6"/></svg></div>` : ''}
        </div>
        <div class="participant-info">
          <div class="participant-name">${esc(name)}</div>
          <div class="participant-role">${p.speaking ? 'Speaking…' : p.muted ? 'Muted' : 'Listening'}</div>
        </div>
        <div class="speaking-waves"><span></span><span></span><span></span><span></span><span></span></div>
      </div>
    `;
      }).join('');
    }

    function setVoiceStatus(state, text) {
      const ind = document.getElementById('voiceIndicator');
      ind.className = 'voice-indicator' + (state ? ' ' + state : '');
      document.getElementById('voiceStatusText').textContent = text;
    }

    /* ═══════════════════════════════════════════════
       CREATE / JOIN SERVER
    ═══════════════════════════════════════════════ */
    let cjMode = 'create';
    function openCreateModal() {
      document.getElementById('createJoinModal').classList.add('open');
      switchCJ('create');
    }
    function closeCreateModal() {
      document.getElementById('createJoinModal').classList.remove('open');
    }
    function switchCJ(mode) {
      cjMode = mode;
      document.getElementById('createForm').style.display = mode === 'create' ? '' : 'none';
      document.getElementById('joinForm').style.display = mode === 'join' ? '' : 'none';
      document.getElementById('cjTitle').textContent = mode === 'create' ? 'Create a Server' : 'Join a Server';
      document.getElementById('cjDesc').textContent = mode === 'create' ? 'Set up a voice & chat room for you and your friends.' : 'Enter the 6-character invite code.';
      document.getElementById('cjSubmitBtn').textContent = mode === 'create' ? 'Create Server' : 'Join Server';
    }

    async function submitCreateJoin() {
      const client = ZenAuth.getSupabaseClient();

      if (cjMode === 'create') {
        const name = document.getElementById('newSrvName').value.trim();
        if (!name) { showToast('Enter a server name', 'error'); return; }
        const desc = document.getElementById('newSrvDesc').value.trim();
        const code = generateCode();

        const { data: srv, error } = await client.from('servers').insert({
          name, description: desc, icon_emoji: selectedEmoji,
          owner_id: myUserId, invite_code: code
        }).select().single();

        if (error) { showToast('Failed to create server', 'error'); return; }

        await client.from('server_members').insert({ server_id: srv.id, user_id: myUserId, role: 'owner' });

        myServers.push(srv);
        renderServerList();
        closeCreateModal();
        showToast('Server created! ', 'success');
        openServer(srv.id);
      } else {
        const code = document.getElementById('joinCode').value.trim().toUpperCase();
        if (code.length !== 4 && code.length !== 6) { showToast('Enter a valid 4-digit or 6-character code', 'error'); return; }

        const { data: srv } = await client.from('servers').select('*').eq('invite_code', code).single();
        if (!srv) { showToast('Server not found', 'error'); return; }

        // Check if already member
        const { data: existing } = await client.from('server_members').select('id').eq('server_id', srv.id).eq('user_id', myUserId).single();
        if (existing) { showToast('Already a member!'); closeCreateModal(); openServer(srv.id); return; }

        await client.from('server_members').insert({ server_id: srv.id, user_id: myUserId, role: 'member' });

        myServers.push(srv);
        renderServerList();
        closeCreateModal();
        showToast('Joined server! ', 'success');
        openServer(srv.id);
      }
    }

    function generateCode(type) {
      if (type === '4') {
        return String(Math.floor(1000 + Math.random() * 9000));
      }
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    }

    async function regenerateCode(type) {
      if (!activeServer) return;
      if (!confirm('Replace the current invite code? The old code will stop working.')) return;
      const code = generateCode(type);
      const client = ZenAuth.getSupabaseClient();
      const { error } = await client.from('servers').update({ invite_code: code }).eq('id', activeServer.id);
      if (error) { showToast('Could not update code: ' + error.message, 'error'); return; }
      activeServer.invite_code = code;
      const idx = myServers.findIndex(s => s.id === activeServer.id);
      if (idx !== -1) myServers[idx].invite_code = code;
      document.getElementById('inviteCodeDisplay').textContent = code;
      // Also update the header badge
      const headerCodeText = document.getElementById('headerCodeText');
      if (headerCodeText) headerCodeText.textContent = code;
      const shareUrl = `${location.origin}${location.pathname}?join=${code}`;
      const linkEl = document.getElementById('inviteLinkDisplay');
      if (linkEl) linkEl.value = shareUrl;
      showToast('New invite code generated!', 'success');
    }

    /* ═══════════════════════════════════════════════
       INVITE MODAL
    ═══════════════════════════════════════════════ */
    function openInviteModal() {
      try {
        console.log('[Invite] openInviteModal called. activeServer =', activeServer);

        if (!activeServer) {
          showToast('Select a server first', 'error');
          console.warn('[Invite] No active server — aborting');
          return;
        }

        const isOwner = activeServer.owner_id === myUserId;
        console.log('[Invite] isOwner =', isOwner, '| invite_code =', activeServer.invite_code);

        // Use code already loaded in activeServer (set during openServer())
        // If missing and user is owner, generate one in the background
        if (!activeServer.invite_code && isOwner) {
          const newCode = generateCode();
          activeServer.invite_code = newCode;
          const idx = myServers.findIndex(s => s.id === activeServer.id);
          if (idx !== -1) myServers[idx].invite_code = newCode;
          // Update header badge
          const headerCodeText = document.getElementById('headerCodeText');
          if (headerCodeText) headerCodeText.textContent = newCode;
          // Persist to DB in background (don't block modal opening)
          try {
            const client = ZenAuth.getSupabaseClient();
            client.from('servers').update({ invite_code: newCode }).eq('id', activeServer.id)
              .then(({ error }) => { if (error) console.warn('[Invite] DB save error:', error); });
          } catch (e) { console.warn('[Invite] Could not persist code:', e); }
        }

        const code = activeServer.invite_code || '------';
        const codeDisplay = document.getElementById('inviteCodeDisplay');
        if (codeDisplay) codeDisplay.textContent = code;

        // Build shareable link
        const shareUrl = code !== '------'
          ? `${location.origin}${location.pathname}?join=${code}`
          : window.location.href;
        const linkEl = document.getElementById('inviteLinkDisplay');
        if (linkEl) linkEl.value = shareUrl;

        // Show/hide regenerate buttons for owners only
        const regenBtns = document.querySelectorAll('#inviteModal .copy-code-btn');
        regenBtns.forEach(btn => {
          if (btn.getAttribute('onclick') && btn.getAttribute('onclick').startsWith('regenerateCode')) {
            btn.style.display = isOwner ? '' : 'none';
          }
        });

        const modal = document.getElementById('inviteModal');
        if (!modal) { console.error('[Invite] #inviteModal element not found!'); return; }
        modal.classList.add('open');
        console.log('[Invite] Modal opened successfully');
      } catch (err) {
        console.error('[Invite] Error in openInviteModal:', err);
      }
    }

    function copyInviteCode() {
      const code = document.getElementById('inviteCodeDisplay').textContent;
      if (!code || code === '------') { showToast('No invite code yet', 'error'); return; }

      const fallbackCopy = () => {
        try {
          const el = document.createElement('textarea');
          el.value = code; el.style.position = 'fixed'; el.style.opacity = '0';
          document.body.appendChild(el); el.select(); document.execCommand('copy');
          document.body.removeChild(el);
          showToast('Code copied!', 'success');
        } catch (e) {
          showToast('Failed to copy code', 'error');
        }
      };

      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(code)
          .then(() => showToast('Code copied!', 'success'))
          .catch(fallbackCopy);
      } else {
        fallbackCopy();
      }
    }

    function copyInviteLink() {
      const linkEl = document.getElementById('inviteLinkDisplay');
      if (!linkEl) return;

      const fallbackCopy = () => {
        try {
          linkEl.select(); document.execCommand('copy');
          showToast('Link copied!', 'success');
        } catch (e) {
          showToast('Failed to copy link', 'error');
        }
      };

      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(linkEl.value)
          .then(() => showToast('Link copied!', 'success'))
          .catch(fallbackCopy);
      } else {
        fallbackCopy();
      }
    }

    /* ═══════════════════════════════════════════════
       LEAVE SERVER
    ═══════════════════════════════════════════════ */
    async function leaveServer() {
      if (!activeServer || activeServer.owner_id === myUserId) return;
      if (!confirm(`Leave "${activeServer.name}"? You can rejoin with the invite code.`)) return;

      if (inVoice) await leaveVoice();

      const client = ZenAuth.getSupabaseClient();
      await client.from('server_members').delete().eq('server_id', activeServer.id).eq('user_id', myUserId);

      myServers = myServers.filter(s => s.id !== activeServer.id);
      activeServer = null;
      renderServerList();
      document.getElementById('srvEmpty').style.display = '';
      document.getElementById('roomView').style.display = 'none';
      showToast('Left server');
    }

    /* ═══════════════════════════════════════════════
       UTILS
    ═══════════════════════════════════════════════ */
    function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
    function escHtml(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '<br>'); }

    let toastTimer;
    function showToast(msg, type) {
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.className = 'toast show' + (type ? ' ' + type : '');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
    }

    // Close modals on overlay click
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.classList.remove('open');
      });
    });

    // Cleanup on page unload
    window.addEventListener('beforeunload', () => {
      if (inVoice) leaveVoice();
      if (localStream) localStream.getTracks().forEach(t => t.stop());
    });
  