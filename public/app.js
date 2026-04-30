// ==========================================
// STATE VARIABLES
// ==========================================
let globalUserId = "";
let userPhone = "";
let globalConversations = [];
let previousConversations = []; // 🆕 Add this so the UI remembers old titles
let currentConversationId = null;
let userName = "Guest";
let isLoadingChat = false;
let chatAbortController = null;
const botAvatar = "/avatar.jpg";
let supabaseClient = null;
let pendingSupabaseSession = null;
let pendingAuthLinkedPhone = false;
let authMode = "signin";


const phoneInputField = document.querySelector("#phoneInput");
const phoneInput = window.intlTelInput(phoneInputField, {
    utilsScript: "https://cdnjs.cloudflare.com/ajax/libs/intl-tel-input/17.0.8/js/utils.js",
    preferredCountries: ["ca", "us", "gb", "au"],
    separateDialCode: true
});

// ==========================================
// CUSTOM MODAL ENGINE
// ==========================================
function buildUIModal(title, text, type, defaultValue = '', isDanger = false) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'custom-modal-overlay';
        
        let inputHtml = type === 'prompt' ? `<input type="text" class="custom-modal-input" value="${defaultValue}" />` : '';
        let cancelBtn = type !== 'alert' ? `<button class="custom-modal-btn cancel">Cancel</button>` : '';
        let confirmClass = isDanger ? 'danger' : 'confirm';
        let confirmText = type === 'alert' ? 'OK' : (type === 'prompt' ? 'Save' : 'Confirm');

        overlay.innerHTML = `
            <div class="custom-modal-box">
                <div class="custom-modal-title">${title}</div>
                <div class="custom-modal-text">${text}</div>
                ${inputHtml}
                <div class="custom-modal-actions">
                    ${cancelBtn}
                    <button class="custom-modal-btn ${confirmClass}">${confirmText}</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        
        // Trigger animation
        setTimeout(() => overlay.classList.add('show'), 10);
        
        const inputEl = overlay.querySelector('.custom-modal-input');
        if (inputEl) inputEl.focus();

        const close = (val) => {
            overlay.classList.remove('show');
            setTimeout(() => overlay.remove(), 200);
            resolve(val);
        };

        overlay.querySelector('.confirm, .danger').onclick = () => close(type === 'prompt' ? inputEl.value : true);
        if (type !== 'alert') overlay.querySelector('.cancel').onclick = () => close(false);
        if (inputEl) inputEl.onkeydown = (e) => { if (e.key === 'Enter') close(inputEl.value); };
    });
}
const uiAlert = (title, text) => buildUIModal(title, text, 'alert');
const uiConfirm = (title, text, isDanger) => buildUIModal(title, text, 'confirm', '', isDanger);
const uiPrompt = (title, text, defaultVal) => buildUIModal(title, text, 'prompt', defaultVal);

// --- SLEEK TOAST NOTIFICATIONS ---
function showToast(message, type = "success") {
    const toast = document.getElementById('toastBox');
    toast.className = 'toast-notification ' + type;
    
    // Choose a crisp, modern SVG based on the type
    const iconSvg = type === 'success' 
        ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4caf50" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`
        : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ff4c4c" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>`;

    toast.innerHTML = `<div style="display: flex; gap: 10px; align-items: center;">
                        <span style="display: flex; align-items: center;">${iconSvg}</span>
                        <span>${escapeHtml(message)}</span>
                       </div>`;
    toast.style.display = 'block';
    toast.style.opacity = '1';
    if (window.toastTimer) clearTimeout(window.toastTimer);
    window.toastTimer = setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => { toast.style.display = 'none'; }, 300);
    }, 3000);
}

async function initSupabaseAuth() {
    try {
        const res = await fetch('/api/auth/public-config');
        const cfg = await res.json();
        if (!cfg.success || !cfg.supabaseUrl || !cfg.supabaseAnonKey || !window.supabase) return;

        supabaseClient = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
            auth: {
                persistSession: true,
                autoRefreshToken: true,
                detectSessionInUrl: true
            }
        });

        const params = new URLSearchParams(window.location.search);
        const hasAuthCallback = params.has('code') || window.location.hash.includes('access_token') || window.location.hash.includes('type=');
        if (params.has('code')) {
            await supabaseClient.auth.exchangeCodeForSession(params.get('code'));
            window.history.replaceState({}, document.title, window.location.pathname + (params.get('reset_password') ? '?reset_password=1' : ''));
        }

        const { data } = await supabaseClient.auth.getSession();
        const isPasswordReset = params.get('reset_password') === '1' || window.location.hash.includes('type=recovery');
        if (isPasswordReset && data.session) {
            showPasswordResetStep();
            return;
        }

        if (data.session && !localStorage.getItem('david_userId') && hasAuthCallback) {
            await beginPhoneSecondFactor(data.session);
        } else if (data.session && !localStorage.getItem('david_userId')) {
            await supabaseClient.auth.signOut();
        }
    } catch (e) {
        console.error("Supabase auth init failed:", e);
    }
}

function requireTermsAccepted() {
    const disclaimerCheck = document.getElementById('disclaimerCheck');
    const phoneDisclaimerCheck = document.getElementById('phoneDisclaimerCheck');
    return !disclaimerCheck || disclaimerCheck.checked || phoneDisclaimerCheck?.checked;
}

function markTermsAcceptedForAuth() {
    sessionStorage.setItem('david_terms_accepted_for_auth', 'true');
}

function hasTermsAcceptedForAuth() {
    return sessionStorage.getItem('david_terms_accepted_for_auth') === 'true';
}

function clearTermsAcceptedForAuth() {
    sessionStorage.removeItem('david_terms_accepted_for_auth');
}

function ensureTermsAcceptedForAuth() {
    if (hasTermsAcceptedForAuth()) return true;
    if (requireTermsAccepted()) {
        markTermsAcceptedForAuth();
        return true;
    }
    return false;
}

function updatePhoneTermsVisibility() {
    const phoneTermsWrap = document.getElementById('phoneTermsWrap');
    if (!phoneTermsWrap) return;
    phoneTermsWrap.style.display = hasTermsAcceptedForAuth() ? 'none' : 'flex';
}

function setAuthMode(mode) {
    authMode = mode === "signup" ? "signup" : "signin";
    document.getElementById('signinTab')?.classList.toggle('active', authMode === "signin");
    document.getElementById('signupTab')?.classList.toggle('active', authMode === "signup");
    const title = document.querySelector('.auth-title');
    if (title) title.innerText = authMode === "signup" ? "Sign Up" : "Sign In";
    const subtitle = document.querySelector('.auth-subtitle');
    if (subtitle) subtitle.innerText = authMode === "signup" ? "Create your always available board advisor account." : "Access your always available board advisor.";
    const nameWrap = document.getElementById('authNameWrap');
    if (nameWrap) nameWrap.style.display = authMode === "signup" ? "block" : "none";
    const passwordInput = document.getElementById('authPasswordInput');
    if (passwordInput) passwordInput.autocomplete = authMode === "signup" ? "new-password" : "current-password";
    const btn = document.getElementById('authPrimaryBtn');
    if (btn) btn.innerText = authMode === "signup" ? "Create Account" : "Sign In";
}

function resetAuthStartScreen() {
    pendingSupabaseSession = null;
    pendingAuthLinkedPhone = false;
    clearTermsAcceptedForAuth();
    setAuthMode("signin");
    document.getElementById('step1').style.display = 'block';
    document.getElementById('step2').style.display = 'none';
    document.getElementById('resetPasswordStep').style.display = 'none';
    document.getElementById('phoneCodeWrap').style.display = 'none';
    document.getElementById('sendPhone2faBtn').style.display = 'block';
    document.getElementById('authNameInput').value = "";
    document.getElementById('authEmailInput').value = "";
    document.getElementById('authPasswordInput').value = "";
    document.getElementById('phoneInput').value = "";
    document.getElementById('codeInput').value = "";
    const disclaimer = document.getElementById('disclaimerCheck');
    if (disclaimer) disclaimer.checked = false;
    const phoneDisclaimer = document.getElementById('phoneDisclaimerCheck');
    if (phoneDisclaimer) phoneDisclaimer.checked = false;
}

function getAuthRedirectUrl(extra = "") {
    return `${window.location.origin}${window.location.pathname}${extra}`;
}

async function signInWithOAuth(provider) {
    if (!supabaseClient) return uiAlert("Login Unavailable", "Authentication is still loading. Please try again.");
    if (!requireTermsAccepted()) return uiAlert("Required", "You must agree to the Disclaimer & Terms before logging in.");
    markTermsAcceptedForAuth();

    const { error } = await supabaseClient.auth.signInWithOAuth({
        provider,
        options: { redirectTo: getAuthRedirectUrl() }
    });
    if (error) await uiAlert("Login Error", error.message);
}

async function submitEmailAuth() {
    if (!supabaseClient) return uiAlert("Login Unavailable", "Authentication is still loading. Please try again.");
    if (!requireTermsAccepted()) return uiAlert("Required", "You must agree to the Disclaimer & Terms before logging in.");
    markTermsAcceptedForAuth();

    const email = document.getElementById('authEmailInput').value.trim().toLowerCase();
    const password = document.getElementById('authPasswordInput').value;
    const fullName = document.getElementById('authNameInput').value.trim();
    const btn = document.getElementById('authPrimaryBtn');

    if (!email || !password) return uiAlert("Missing Info", "Enter your email and password.");
    if (authMode === "signup" && password.length < 8) return uiAlert("Password", "Use at least 8 characters.");

    btn.disabled = true;
    btn.innerText = authMode === "signup" ? "Creating..." : "Signing in...";
    try {
        let result;
        if (authMode === "signup") {
            result = await supabaseClient.auth.signUp({
                email,
                password,
                options: {
                    data: { full_name: fullName },
                    emailRedirectTo: getAuthRedirectUrl()
                }
            });
        } else {
            result = await supabaseClient.auth.signInWithPassword({ email, password });
        }

        if (result.error) throw result.error;

        if (!result.data.session) {
            await uiAlert("Check Your Email", "Confirm your email, then come back and sign in.");
            resetAuthStartScreen();
            return;
        }

        await beginPhoneSecondFactor(result.data.session);
    } catch (e) {
        await uiAlert("Login Error", e.message || "Could not sign in.");
    } finally {
        btn.disabled = false;
        btn.innerText = authMode === "signup" ? "Create Account" : "Sign In";
    }
}

async function sendPasswordReset() {
    if (!supabaseClient) return uiAlert("Login Unavailable", "Authentication is still loading. Please try again.");
    const email = document.getElementById('authEmailInput').value.trim().toLowerCase();
    if (!email) return uiAlert("Email Required", "Enter your email address first.");

    const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
        redirectTo: getAuthRedirectUrl("?reset_password=1")
    });
    if (error) return uiAlert("Reset Error", error.message);
    await uiAlert("Check Your Email", "Use the reset link we sent to create a new password.");
}

function showPasswordResetStep() {
    document.getElementById('step1').style.display = 'none';
    document.getElementById('step2').style.display = 'none';
    document.getElementById('resetPasswordStep').style.display = 'block';
}

async function completePasswordReset() {
    if (!supabaseClient) return;
    const password = document.getElementById('newPasswordInput').value;
    const confirm = document.getElementById('confirmPasswordInput').value;
    if (!password || password.length < 8) return uiAlert("Password", "Use at least 8 characters.");
    if (password !== confirm) return uiAlert("Password", "Passwords do not match.");

    const { data, error } = await supabaseClient.auth.updateUser({ password });
    if (error) return uiAlert("Reset Error", error.message);
    const sessionResult = await supabaseClient.auth.getSession();
    await uiAlert("Password Updated", "Now confirm your phone number to enter the portal.");
    await beginPhoneSecondFactor(sessionResult.data.session || data.session);
}

async function beginPhoneSecondFactor(session) {
    pendingSupabaseSession = session;
    pendingAuthLinkedPhone = false;
    document.getElementById('step1').style.display = 'none';
    document.getElementById('resetPasswordStep').style.display = 'none';
    document.getElementById('step2').style.display = 'block';
    document.getElementById('phoneCodeWrap').style.display = 'none';
    const title = document.querySelector('.auth-title');
    if (title) title.innerText = "Verify Phone";
    const subtitle = document.querySelector('.auth-subtitle');
    if (subtitle) subtitle.innerText = "Use your phone number to protect your account.";

    const intro = document.getElementById('phone2faIntro');
    const phoneWrap = document.getElementById('phone2faInputWrap');
    const sendBtn = document.getElementById('sendPhone2faBtn');
    updatePhoneTermsVisibility();

    intro.innerText = "Confirm your phone number to finish signing in.";
    phoneWrap.style.display = 'block';
    sendBtn.style.display = 'block';
    sendBtn.innerText = "Send Phone Code";

    try {
        const res = await fetch('/api/auth/oauth/status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accessToken: session.access_token })
        });
        const data = await res.json();
        if (data.success && data.linked) {
            pendingAuthLinkedPhone = true;
            intro.innerText = `For your security, enter the code sent to ${data.maskedPhone}.`;
            phoneWrap.style.display = 'none';
            sendBtn.innerText = "Send Code";
            if (ensureTermsAcceptedForAuth()) {
                setTimeout(() => sendOAuthPhoneCode(), 0);
            }
        }
    } catch (e) {
        console.error("OAuth status check failed:", e);
    }
}

async function sendOAuthPhoneCode() {
    const btn = document.getElementById('sendPhone2faBtn');
    const resendBtn = document.getElementById('resendPhoneCodeBtn');
    if (!pendingSupabaseSession || btn.disabled || resendBtn?.disabled) return;
    if (!ensureTermsAcceptedForAuth()) {
        updatePhoneTermsVisibility();
        return uiAlert("Required", "Check the Disclaimer & Terms box before requesting your phone code.");
    }
    updatePhoneTermsVisibility();

    const phone = pendingAuthLinkedPhone ? null : phoneInput.getNumber();
    if (!pendingAuthLinkedPhone && !phone) return uiAlert("Invalid Number", "Please enter a valid phone number.");

    btn.disabled = true;
    btn.innerText = "Sending...";
    if (resendBtn) {
        resendBtn.disabled = true;
        resendBtn.innerText = "Sending...";
    }
    let codeSent = false;
    try {
        const res = await fetch('/api/auth/oauth/send-phone-code', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accessToken: pendingSupabaseSession.access_token, phone })
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || "Could not send code.");
        if (data.linked) pendingAuthLinkedPhone = true;
        codeSent = true;
        btn.style.display = 'none';
        document.getElementById('phoneCodeWrap').style.display = 'block';
        document.getElementById('codeInput').focus();
    } catch (e) {
        await uiAlert("Code Error", e.message);
    } finally {
        btn.disabled = false;
        if (!codeSent) btn.innerText = pendingAuthLinkedPhone ? "Send Code" : "Send Phone Code";
        if (resendBtn) {
            resendBtn.disabled = false;
            resendBtn.innerText = "Resend code";
        }
    }
}

async function verifyOAuthPhoneCode() {
    const btn = document.querySelector('#phoneCodeWrap .auth-button');
    const code = document.getElementById('codeInput').value.trim();
    if (!pendingSupabaseSession || !code || btn.disabled) return;

    const phone = pendingAuthLinkedPhone ? null : phoneInput.getNumber();
    btn.disabled = true;
    btn.innerText = "Verifying...";
    try {
        const res = await fetch('/api/auth/oauth/verify-phone-code', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accessToken: pendingSupabaseSession.access_token, phone, code })
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || "Verification failed.");
        completeAppLogin(data);
    } catch (e) {
        await uiAlert("Verification Error", e.message);
    } finally {
        btn.disabled = false;
        btn.innerText = "Enter Portal";
    }
}

function completeAppLogin(data) {
    globalUserId = data.userId;
    userName = (data.name && data.name.toLowerCase() !== "null") ? data.name.split(' ')[0] : "Guest";
    localStorage.setItem('david_userId', globalUserId);
    localStorage.setItem('david_userName', userName);
    localStorage.setItem('david_last_active', Date.now());
    localStorage.setItem('david_previous_login', data.previousLogin);

    document.querySelectorAll('.login-tag-text').forEach(el => el.innerText = "Logged in as " + userName);
    document.getElementById('loginContainer').style.display = 'none';
    document.getElementById('dashboardContainer').style.display = 'flex';
    clearTermsAcceptedForAuth();
    initDashboard();
}

function backToPrimaryAuth() {
    pendingSupabaseSession = null;
    pendingAuthLinkedPhone = false;
    clearTermsAcceptedForAuth();
    document.getElementById('step2').style.display = 'none';
    document.getElementById('resetPasswordStep').style.display = 'none';
    document.getElementById('step1').style.display = 'block';
    document.getElementById('sendPhone2faBtn').style.display = 'block';
    setAuthMode(authMode);
}
// ==========================================
// MOBILE APP TAB SWITCHING
// ==========================================
function switchMobileTab(event, tabClass) {
    if (window.innerWidth > 768) return; // Ignore if on desktop
    
    // 1. Hide all panels
    document.querySelector('.sidebar').classList.remove('mobile-active');
    document.querySelector('.chat-area').classList.remove('mobile-active');
    document.querySelector('.right-sidebar').classList.remove('mobile-active');
    
    // 2. Show the target panel
    document.querySelector('.' + tabClass).classList.add('mobile-active');
    
    // 3. Update bottom nav button colors
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    event.currentTarget.classList.add('active');
}

// Automatically set 'Chat' as default mobile tab AND check for saved login session
window.addEventListener('DOMContentLoaded', async () => {

    // --- NEW: Force clear cached form inputs on reload/back-button ---
    const phoneEl = document.getElementById('phoneInput');
    if (phoneEl) phoneEl.value = "";
    const codeEl = document.getElementById('codeInput');
    if (codeEl) codeEl.value = "";
    const checkEl = document.getElementById('disclaimerCheck');
    if (checkEl) checkEl.checked = false;

    // Allow hitting Enter in auth fields.
    document.getElementById('authEmailInput')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitEmailAuth(); } });
    document.getElementById('authPasswordInput')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitEmailAuth(); } });
    document.getElementById('phoneInput')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendOAuthPhoneCode(); } });
    document.getElementById('codeInput')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); verifyOAuthPhoneCode(); } });

    setAuthMode("signin");
    await initSupabaseAuth();

    // 1. Mobile/Tablet Tab Default (Updated to 1024px)
    if (window.innerWidth <= 1024) {
        document.querySelector('.chat-area').classList.add('mobile-active');
    }

  // 2. Auto-Login Check
    const savedUserId = localStorage.getItem('david_userId');
    const lastActive = localStorage.getItem('david_last_active');
    const TWELVE_HOURS = 12 * 60 * 60 * 1000;

    // Check if the session exists BUT has been inactive for > 12 hours
    if (savedUserId && lastActive && (Date.now() - parseInt(lastActive) > TWELVE_HOURS)) {
        console.log("Session expired due to inactivity.");
        localStorage.removeItem('david_userId');
        localStorage.removeItem('david_userName');
        // david_userPhone no longer stored in localStorage
        localStorage.removeItem('david_jwt');
        localStorage.removeItem('david_last_active');
        // Do not auto-login, leave them on the Sign In screen
    } else if (savedUserId) {
        // Valid session! Boot up the app (cookie will be validated on first API call)
        globalUserId = savedUserId;
        userName = localStorage.getItem('david_userName') || "Guest";
        // 🔒 Phone number no longer stored in localStorage for privacy
        
        localStorage.setItem('david_last_active', Date.now()); // Reset timer on fresh load
        
        document.querySelectorAll('.login-tag-text').forEach(el => el.innerText = "Logged in as " + userName);
        document.getElementById('loginContainer').style.display = 'none';
        document.getElementById('dashboardContainer').style.display = 'flex';
        initDashboard().catch(() => {
            // If initDashboard fails (cookie expired), force logout
            console.log("Session cookie expired. Redirecting to login.");
            logoutUser();
        }); 
    }
});

function logoutUser() {
    if (supabaseClient) {
        supabaseClient.auth.signOut().catch(e => console.error("Supabase signout failed", e));
    }
    // Notify backend of logout (cookie is sent automatically)
    fetch('/api/web/logout', { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }
    }).catch(e => console.error("Logout ping failed", e));

    globalUserId = "";
    userPhone = "";
    currentConversationId = null;
    
    // --- Clear Local Storage (JWT is no longer stored here — it's in an HttpOnly cookie cleared by the server) ---
    localStorage.removeItem('david_userId');
    localStorage.removeItem('david_userName');
    // david_userPhone no longer stored in localStorage
    localStorage.removeItem('david_last_active');
    localStorage.removeItem('david_previous_login');
    // --------------------------------

    document.getElementById('dashboardContainer').style.display = 'none';
    
    //  THE FIX: Change this to 'flex' so the login layout doesn't break!
    document.getElementById('loginContainer').style.display = 'flex'; 
    document.getElementById('step2').style.display = 'none';
    document.getElementById('resetPasswordStep').style.display = 'none';
    document.getElementById('step1').style.display = 'block';
    
    // --- Wipe all inputs clean on logout ---
    document.getElementById('codeInput').value = "";
    document.getElementById('phoneInput').value = ""; 
    document.getElementById('authPasswordInput').value = "";
    document.getElementById('newPasswordInput').value = "";
    document.getElementById('confirmPasswordInput').value = "";
    document.getElementById('phoneCodeWrap').style.display = 'none';
    document.getElementById('sendPhone2faBtn').style.display = 'block';
    const disclaimer = document.getElementById('disclaimerCheck');
    if (disclaimer) disclaimer.checked = false; 

    document.getElementById('authPrimaryBtn').innerText = authMode === "signup" ? "Create Account" : "Sign In";
    document.getElementById('sendPhone2faBtn').innerText = "Send Phone Code";
    document.getElementById('chatMessages').innerHTML = "";
    document.getElementById('chatList').innerHTML = "";
}

// ==========================================
// DASHBOARD INITIALIZATION
// ==========================================
async function initDashboard() {
    currentConversationId = null;
    document.getElementById('chatMessages').innerHTML = '<div class="empty-state" id="emptyState"><h3>Loading...</h3></div>';
    loadUserDocuments();
    await loadConversationList(true);
    syncUserIdentity();
}

// ==========================================
// CREATE NEW CHAT
// ==========================================
// ==========================================
// CREATE NEW CHAT
// ==========================================
async function startNewChat() {
    try {
        const res = await fetch('/api/web/conversations/new', {
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' }
        });
        const data = await res.json();
        if (data.success) {
            currentConversationId = data.conversationId;
            document.getElementById('chatMessages').innerHTML = "";
            showEmptyState();
            document.getElementById('chatSubtitle').innerText = "Workspace (New Conversation)";
            await loadConversationList(false);
            document.querySelectorAll('.chat-item').forEach(el => {
                el.classList.toggle('active', el.dataset.id === currentConversationId);
            });

            // --- NEW: AUTO-SWITCH TO CHAT TAB ON MOBILE ---
            if (window.innerWidth <= 768) {
                document.querySelector('.sidebar').classList.remove('mobile-active');
                document.querySelector('.right-sidebar').classList.remove('mobile-active');
                document.querySelector('.chat-area').classList.add('mobile-active');
                
                document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
                document.querySelectorAll('.nav-btn')[1].classList.add('active');
            }
            // ----------------------------------------------
        }
    } catch (e) { 
        console.error("Failed to create new chat:", e); 
    }
}

// 🔍 CHAT FILTERING LOGIC
function filterChats() {
    renderConversations();
}

function renderConversations() {
    const list = document.getElementById('chatList');
    const query = document.getElementById('chatSearch').value.toLowerCase();
    const filter = document.getElementById('chatFilter').value;

    list.innerHTML = "";

    const filtered = globalConversations.filter(c => {
        const textMatch = (c.preview || "").toLowerCase().includes(query) || (c.title || "").toLowerCase().includes(query);
        const typeMatch = filter === 'all' ? true : c.channel === filter;
        return textMatch && typeMatch;
    });

    if (filtered.length === 0) {
        list.innerHTML = '<div style="padding:12px;color:#555;font-size:13px;text-align:center;">No chats found</div>';
        return;
    }

    filtered.forEach(c => {
        const d = new Date(c.lastActive);
        const dateStr = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
        const isActive = c.id === currentConversationId;

        const item = document.createElement('div');
        item.className = 'chat-item' + (isActive ? ' active' : '');
        item.dataset.id = c.id;
        
        item.onclick = () => switchChat(c.id);
        
 // 🆕 Check if the title just changed to trigger the animation
        const prevChat = previousConversations.find(p => p.id === c.id);
        const isRenamed = prevChat && prevChat.preview !== c.preview;
        const titleClass = isRenamed ? "chat-item-title chat-title-animated" : "chat-item-title";

        // 🚨 FIX: Re-declare the safe variables so the UI doesn't crash!
        const safePreview = escapeHtml(c.preview || "New conversation");
        const escapedForFunc = safePreview.replace(/'/g, "\\'").replace(/"/g, "&quot;");

        // 📞 Add a high-visibility badge if it was a voice call!
        const displayTitle = c.channel === 'call'
            ? `<span style="background: rgba(76, 175, 80, 0.2); color: #4caf50; padding: 2px 6px; border-radius: 4px; font-size: 10px; margin-right: 6px; font-weight: 600; letter-spacing: 0.5px; vertical-align: middle;">📞 VOICE</span><span style="vertical-align: middle;">${safePreview}</span>` 
            : safePreview;

        item.innerHTML = `
            <div class="chat-item-text" onclick="switchChat('${c.id}')">
                <div class="${titleClass}">${displayTitle}</div>
                <span class="chat-item-date">${dateStr}</span>
            </div>
            <div class="chat-actions-container">
                <button class="chat-action-btn" onclick="event.stopPropagation(); renameChat('${c.id}', '${escapedForFunc}')" title="Rename chat">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>
                </button>
                <button class="chat-action-btn chat-delete-btn" onclick="event.stopPropagation(); deleteChat('${c.id}')" title="Delete chat">×</button>
            </div>
        `;
        list.appendChild(item);
    });
}

// 🌐 LOAD CONVERSATIONS (UPDATED FOR FILTERS)
async function loadConversationList(autoSelect = false) {
    try {
       const res = await fetch("/api/web/conversations", { 
            cache: "no-store" 
        });
        
        // 🔒 If the HttpOnly cookie expired, the server returns 401. Force logout.
        if (res.status === 401 || res.status === 403) {
            logoutUser();
            return;
        }
        
        const data = await res.json();
        
       if (data.success && data.conversations) {
            previousConversations = [...globalConversations]; // 🆕 Save the old state
            globalConversations = data.conversations;
        } else {
            globalConversations = [];
        }
        
        renderConversations();

        // 🧠 SMART BOOT LOGIC
        if (autoSelect && !currentConversationId) {
            if (globalConversations.length > 0) {
                // If they have history, open the most recent chat
                await switchChat(globalConversations[0].id);
            } else {
                // 🆕 FIX: If they are a brand new user with 0 chats, 
                // trigger a new chat instantly so they never see "Loading..."
                console.log("✨ New user detected. Auto-starting first conversation...");
                await startNewChat();
            }
        }

        // --- NEW: Keep Workspace Header in Sync ---
        if (currentConversationId) {
            const activeChat = globalConversations.find(c => c.id === currentConversationId);
            if (activeChat) {
                const chatTitle = activeChat.title || activeChat.preview || "New Conversation";
                document.getElementById('chatSubtitle').innerText = `Workspace (${chatTitle})`;
            }
        }
        // ------------------------------------------

    } catch (e) {
        console.error("Failed to load conversation list:", e);
    }
}

// ==========================================
// RENAME & SWITCH CHAT
// ==========================================
async function renameChat(conversationId, currentTitle) {
    const cleanTitle = currentTitle === 'New conversation' ? '' : currentTitle;
    const newTitle = await uiPrompt("Rename Chat", "Enter a new name for this chat (leave blank to auto-generate):", cleanTitle);
    if (newTitle === false || newTitle.trim() === cleanTitle) return; // User canceled or didn't change it
    
    const finalTitle = newTitle.trim() || "New conversation";

    //  OPTIMISTIC UPDATE: Change the UI instantly
    const chat = globalConversations.find(c => c.id === conversationId);
    if (chat) chat.title = finalTitle;
    if (conversationId === currentConversationId) document.getElementById('chatSubtitle').innerText = `Workspace (${finalTitle})`;
    renderConversations();

    try {
        const res = await fetch(`/api/web/conversations/${conversationId}/title`, { 
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify({ title: finalTitle }) 
        });
        const data = await res.json();
        if (!data.success) throw new Error("Rename failed");
        showToast("Chat renamed!");
    } catch (e) { 
        showToast("Failed to rename chat on server.", "error");
        await loadConversationList(false); // Revert UI if server fails
    }
}

async function switchChat(conversationId) {
    // --- NEW: ALWAYS AUTO-SWITCH TO CHAT TAB ON MOBILE FIRST ---
    if (window.innerWidth <= 768) {
        document.querySelector('.sidebar').classList.remove('mobile-active');
        document.querySelector('.right-sidebar').classList.remove('mobile-active');
        document.querySelector('.chat-area').classList.add('mobile-active');
        
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.nav-btn')[1].classList.add('active'); // Selects the middle Chat button
    }
    // ----------------------------------------------

    if (isLoadingChat) return;
    if (conversationId === currentConversationId && document.getElementById('chatMessages').children.length > 0) return;
    
    isLoadingChat = true;
    currentConversationId = conversationId;

    const activeChat = globalConversations.find(c => c.id === conversationId);
    const chatTitle = activeChat ? (activeChat.title || activeChat.preview || "New Conversation") : "New Conversation";
    document.getElementById('chatSubtitle').innerText = `Workspace (${chatTitle})`;

    document.querySelectorAll('.chat-item').forEach(el => {
        el.classList.toggle('active', el.dataset.id === conversationId);
    });

    const msgContainer = document.getElementById('chatMessages');
    msgContainer.innerHTML = '<div style="text-align:center;padding:40px;color:#bbb;">Loading messages...</div>';

    try {
       const res = await fetch(`/api/web/messages?conversationId=${conversationId}`, { 
            cache: "no-store" 
        });
        const data = await res.json();
        
        msgContainer.innerHTML = "";

        if (data.success && data.messages && data.messages.length > 0) {
            data.messages.forEach(m => {
                addMessageToUI(m.text, m.direction === "agent" ? "bot" : "user");
            });
        } else {
            showEmptyState();
        }
    } catch (e) {
        console.error("Failed to load conversation:", e);
        msgContainer.innerHTML = '<div style="text-align:center;padding:40px;color:#ff4c4c;">Failed to load messages.</div>';
    } finally {
        isLoadingChat = false;
    }
}

async function deleteChat(conversationId) {
    const confirmed = await uiConfirm("Delete Chat", "Are you sure you want to permanently delete this conversation?", true);
    if (!confirmed) return;

    //  OPTIMISTIC UPDATE: Remove from UI instantly
    globalConversations = globalConversations.filter(c => c.id !== conversationId);
    renderConversations();
    
    if (conversationId === currentConversationId) {
        currentConversationId = null;
        document.getElementById('chatMessages').innerHTML = "";
        showEmptyState();
        document.getElementById('chatSubtitle').innerText = "Workspace (New Conversation)";
    }

    try {
        const res = await fetch("/api/web/conversations/" + conversationId, {
            method: 'DELETE', headers: { 'Content-Type': 'application/json' }
        });
        const data = await res.json();
        if (!data.success) throw new Error("Delete failed");
        showToast("Chat deleted.");
    } catch (e) { 
        showToast("Failed to delete chat.", "error");
        await loadConversationList(currentConversationId === null); // Revert UI if server fails
    }
}




// ==========================================
// TYPING INDICATOR
// ==========================================
function showTyping() {
    const msgContainer = document.getElementById('chatMessages');
    const wrapper = document.createElement('div');
    wrapper.id = "typingBubble";
    wrapper.className = "typing-wrapper";
    wrapper.innerHTML = `
        <img src="${botAvatar}" class="avatar" alt="AI" />
        <div class="typing-indicator">
            <span></span><span></span><span></span>
        </div>
    `;
    msgContainer.appendChild(wrapper);
    msgContainer.scrollTop = msgContainer.scrollHeight;
}

function removeTyping() {
    const typingBubble = document.getElementById('typingBubble');
    if (typingBubble) typingBubble.remove();
}
// ==========================================
// SEND MESSAGE
// ==========================================
// ==========================================
// TEXTAREA AUTO-RESIZE & SHIFT+ENTER
// ==========================================
document.addEventListener("DOMContentLoaded", () => {
    const chatInput = document.getElementById('chatInput');
    if (chatInput) {
        chatInput.addEventListener('keydown', function(e) {
            // Send on Enter (but drop to new line on Shift+Enter)
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault(); 
                sendMessage();
            }
        });
        chatInput.addEventListener('input', function() {
            this.style.height = 'auto'; // Reset height to recalculate
            this.style.height = (this.scrollHeight) + 'px'; 
            if (this.value === "") this.style.height = 'auto'; 
        });
    }
});

function stopGenerating() {
    if (chatAbortController) {
        chatAbortController.abort(); // Kills the fetch request instantly
        chatAbortController = null;
    }
    document.getElementById('stopBtn').style.display = 'none';
    document.getElementById('sendBtn').style.display = 'block';
    removeTyping();

    // --- NEW: Remove the aborted messages from the UI ---
    const msgContainer = document.getElementById('chatMessages');
    const wrappers = msgContainer.querySelectorAll('.message-wrapper');
    if (wrappers.length >= 2) {
        const last = wrappers[wrappers.length - 1];
        const prev = wrappers[wrappers.length - 2];
        // Ensure we are deleting the aborted bot bubble AND the user prompt
        if (last.classList.contains('wrapper-bot') && prev.classList.contains('wrapper-user')) {
            last.remove();
            prev.remove();
        }
    }

    document.getElementById('chatInput').disabled = false;
    document.getElementById('chatInput').focus();
}

// ==========================================
// SEND MESSAGE (STREAMING)
// ==========================================
async function sendMessage() {
    const inputField = document.getElementById('chatInput');
    const message = inputField.value.trim();
    if (!message) return;
    
    if (!currentConversationId) {
        await startNewChat();
        if (!currentConversationId) return; 
    }

    const es = document.getElementById('emptyState');
    if (es) es.remove();

    const checkedBoxes = document.querySelectorAll('.doc-checkbox:checked');
    const selectedDocIds = Array.from(checkedBoxes).map(cb => cb.value);
    const isDeepDive = document.getElementById('deepDiveToggle').checked;

    addMessageToUI(message, 'user', selectedDocIds.length, isDeepDive);
    
    // Reset input box
    inputField.value = "";
    inputField.style.height = 'auto';

   // Swap Send for Stop
    const sendBtn = document.getElementById('sendBtn');
    const stopBtn = document.getElementById('stopBtn');
    sendBtn.style.display = 'none';
    stopBtn.style.display = 'flex';

    showTyping();
    chatAbortController = new AbortController();

    try {
        const res = await fetch('/api/chat', {
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message, conversationId: currentConversationId, selectedDocIds, deepDive: isDeepDive }),
            signal: chatAbortController.signal // Hooks into our Stop button!
        });

      removeTyping();

        // 1. Create message bubble with a Thinking Timer
        const msgContainer = document.getElementById('chatMessages');
        const wrapper = document.createElement('div');
        wrapper.classList.add('message-wrapper', 'wrapper-bot');
        
        wrapper.innerHTML = `
            <img src="${botAvatar}" class="avatar" alt="AI" />
            <div style="display: flex; flex-direction: column; align-items: flex-start; max-width: 100%;">
                <div class="message msg-bot streaming-text">
                    <div class="thinking-ui">
                        <svg class="think-spinner" viewBox="0 0 50 50"><circle cx="25" cy="25" r="20" fill="none" stroke-width="5"></circle></svg>
                        <span>Thinking... <span class="think-timer">0.0s</span></span>
                    </div>
                </div>
                <button class="copy-action-btn" style="display:none;">📋 Copy Text</button>
            </div>
        `;
        msgContainer.appendChild(wrapper);
        msgContainer.scrollTop = msgContainer.scrollHeight;
        
        const textNode = wrapper.querySelector('.streaming-text');
        const timerNode = wrapper.querySelector('.think-timer');
        const copyBtn = wrapper.querySelector('.copy-action-btn');
        let fullReply = "";
        
        // Start the live stopwatch
        let startTime = Date.now();
        let thinkInterval = setInterval(() => {
            if (timerNode) {
                timerNode.innerText = ((Date.now() - startTime) / 1000).toFixed(1) + 's';
            }
        }, 100);

        // 2. Read the Stream Data
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let done = false;
        let firstTextArrived = false;
        let finalThinkTime = "";

        while (!done) {
            const { value, done: readerDone } = await reader.read();
            if (value) {
                const chunkStr = decoder.decode(value, { stream: true });
                const lines = chunkStr.split('\n');
                
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const dataStr = line.substring(6).trim();
                        if (dataStr === '[DONE]') { done = true; break; }
                        
                        try {
                            const data = JSON.parse(dataStr);
                            if (data.type === 'meta' && data.conversationId) {
                                currentConversationId = data.conversationId;
                            } else if (data.type === 'chunk') {
                                
                                // The moment the AI spits out its first real word, stop the timer!
                                if (!firstTextArrived) {
                                    firstTextArrived = true;
                                    clearInterval(thinkInterval);
                                    finalThinkTime = ((Date.now() - startTime) / 1000).toFixed(1);
                                }
                                
                                fullReply += data.text;
                                
                                // Parse the markdown, but lock the "Thought for X.Xs" badge to the top
                                const renderedMarkdown = marked.parse(fullReply);
                                textNode.innerHTML = `<div class="thought-badge">Thought for ${finalThinkTime}s</div>` + renderedMarkdown;
                                msgContainer.scrollTop = msgContainer.scrollHeight;
                                
                            } else if (data.type === 'error') {
                                clearInterval(thinkInterval);
                                fullReply += "\n\n**Error:** " + data.error;
                                textNode.innerHTML = marked.parse(fullReply);
                            }
                        } catch(e) {}
                    }
                }
            }
            if (readerDone) done = true;
        }
        clearInterval(thinkInterval); // Failsafe cleanup

       // 3. Finalize
        copyBtn.style.display = 'block';
        copyBtn.onclick = function() { copyMessageText(this, encodeURIComponent(fullReply)); };
        
        // 🧠 FIX: Wait 1.5 seconds to let the server finish generating the title before refreshing UI
        setTimeout(() => loadConversationList(false), 1500);

    } catch (error) {
        if (error.name === 'AbortError') {
            console.log("Generation stopped by user.");
        } else {
            console.error("Chat network error:", error);
            removeTyping();
            addMessageToUI("Network error. Please check your connection.", 'bot');
        }
    } finally {
        // Swap Stop back to Send
        sendBtn.style.display = 'block';
        stopBtn.style.display = 'none';
        setTimeout(syncUserIdentity, 2000);
    }
}

// ==========================================
// IN-APP DOCUMENT VIEWER
// ==========================================
async function viewDocument(docId) {
    const btn = document.querySelector(`#menu-${docId} button`);
    const originalText = btn.innerText;
    btn.innerText = "Loading...";

    try {
        const res = await fetch(`/api/documents/${docId}/content`);
        const data = await res.json();
        
        if (data.success) {
            const overlay = document.createElement('div');
            overlay.className = 'custom-modal-overlay';
            overlay.innerHTML = `
                <div class="custom-modal-box" style="max-width: 800px; width: 90%; height: 80vh; display: flex; flex-direction: column;">
                    <div class="custom-modal-title" style="margin-bottom: 8px;">${escapeHtml(data.name)}</div>
                    <div style="font-size: 12px; color: #888; margin-bottom: 16px;">This is the raw, unformatted text that David extracted and memorized.</div>
                    <div style="flex: 1; overflow-y: auto; background: #f4f5f7; padding: 20px; border-radius: 8px; border: 1px solid #e1e4e8; font-family: 'Inter', sans-serif; font-size: 13px; line-height: 1.6; white-space: pre-wrap; color: #333;">${escapeHtml(data.text)}</div>
                    <div class="custom-modal-actions" style="margin-top: 20px;">
                        <button class="custom-modal-btn confirm" onclick="this.closest('.custom-modal-overlay').classList.remove('show'); setTimeout(() => this.closest('.custom-modal-overlay').remove(), 200);">Close Viewer</button>
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);
            setTimeout(() => overlay.classList.add('show'), 10);
        } else {
            uiAlert("Error", "Could not load document content.");
        }
    } catch (e) {
        console.error(e);
        uiAlert("Error", "Failed to connect to server.");
    } finally {
        btn.innerText = originalText;
    }
}

function addMessageToUI(text, sender, fileCount = 0, isDeepDive = false) {
    const msgContainer = document.getElementById('chatMessages');
    const es = document.getElementById('emptyState');
    if (es) es.remove();

    const wrapper = document.createElement('div');
    wrapper.classList.add('message-wrapper', sender === 'bot' ? 'wrapper-bot' : 'wrapper-user');

    let formatted = "";
    if (sender === 'bot') {
        // Let Marked.js perfectly handle all bolding, lists, and line breaks
        formatted = marked.parse(text); 
    } else {
        // Keep user messages plain and safe
        formatted = escapeHtml(text).replace(/\n/g, '<br>');
    }

    // Safely encode the text so quotes don't break the HTML button
    const safeText = encodeURIComponent(text);

    if (sender === 'bot') {
        wrapper.innerHTML = `
            <img src="${botAvatar}" class="avatar" alt="AI" />
            <div style="display: flex; flex-direction: column; align-items: flex-start; max-width: 100%;">
                <div class="message msg-bot">${formatted}</div>
                <button class="copy-action-btn" onclick="copyMessageText(this, '${safeText}')">📋 Copy Text</button>
            </div>
        `;
    } else {
        // Build the user bubble with dynamic badges and copy button
        let userHtml = `<div style="display: flex; flex-direction: column; align-items: flex-end; max-width: 100%;">`;
        userHtml += `<div class="message msg-user">${formatted}</div>`;
        
        // Flex container for badges + copy button
        userHtml += `<div style="display: flex; align-items: center; gap: 10px; margin-top: 6px;">`;
        userHtml += `<button class="copy-action-btn" style="margin-top: 0;" onclick="copyMessageText(this, '${safeText}')">📋 Copy</button>`;
        
        if (fileCount > 0) {
            userHtml += `<span style="background: #0284c7; color: white; padding: 4px 10px; border-radius: 6px; font-size: 11px; font-weight: 600; display: flex; align-items: center; gap: 5px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
                            ${fileCount} File(s) Attached
                         </span>`;
        }
        if (isDeepDive) {
            userHtml += `<span style="background: #db2777; color: white; padding: 4px 10px; border-radius: 6px; font-size: 11px; font-weight: 600; display: flex; align-items: center; gap: 5px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="6"></circle><circle cx="12" cy="12" r="2"></circle></svg>
                            Deep Dive Active
                         </span>`;
        }
        userHtml += `</div></div>`;
        
        wrapper.innerHTML = userHtml;
    }
    
    msgContainer.appendChild(wrapper);
    msgContainer.scrollTop = msgContainer.scrollHeight;
}

function showEmptyState() {
    const msgContainer = document.getElementById('chatMessages');
    if (!document.getElementById('emptyState')) {
        msgContainer.innerHTML = '<div class="empty-state" id="emptyState"><h3>New Conversation</h3><p>Ask David about board governance, corporate strategy, or upload documents for analysis.</p></div>';
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ==========================================
// DOCUMENT MANAGEMENT (RIGHT SIDEBAR)
// ==========================================
function getFileIcon(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    if(ext === 'pdf') return `<div class="doc-icon icon-pdf">PDF</div>`;
    if(ext === 'docx' || ext === 'doc') return `<div class="doc-icon icon-doc">DOC</div>`;
    return `<div class="doc-icon icon-txt">TXT</div>`;
}

function filterDocs() {
    const query = document.getElementById('docSearch').value.toLowerCase();
    const rows = document.querySelectorAll('.doc-row');
    rows.forEach(row => {
        const text = row.querySelector('.doc-name').innerText.toLowerCase();
        row.style.display = text.includes(query) ? "flex" : "none";
    });
}

function toggleDocMenu(event, docId) {
    event.stopPropagation();
    event.preventDefault();
    // Close others
    document.querySelectorAll('.doc-dropdown').forEach(d => {
        if (d.id !== 'menu-' + docId) d.classList.remove('show');
    });
    // Toggle current
    document.getElementById('menu-' + docId).classList.toggle('show');
}

function closeAllDropdowns() {
    document.querySelectorAll('.doc-dropdown').forEach(d => d.classList.remove('show'));
}

async function renameDocument(docId, oldFullName) {
    const extIdx = oldFullName.lastIndexOf('.');
    const baseName = extIdx > 0 ? oldFullName.substring(0, extIdx) : oldFullName;
    const ext = extIdx > 0 ? oldFullName.substring(extIdx) : '';

    const newBaseName = await uiPrompt("Rename Document", "Enter a new name for this file:", baseName);
    if (!newBaseName || newBaseName.trim() === baseName) return;
    const finalName = newBaseName.trim() + ext; 
    
    // 🔥 OPTIMISTIC UPDATE
    const docEl = document.querySelector(`#menu-${docId}`).closest('.doc-row').querySelector('.doc-name');
    if (docEl) docEl.innerText = finalName;
    closeAllDropdowns();
    
    try {
        const res = await fetch(`/api/documents/${docId}/name`, { 
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify({ newName: finalName }) 
        });
        const data = await res.json();
        if (!data.success) throw new Error("Rename failed");
        showToast("Document renamed!");
    } catch (e) { 
        showToast("Failed to rename document.", "error");
        loadUserDocuments(); // Revert UI if server fails
    }
}

async function deleteDocument(docId) {
    const confirmed = await uiConfirm("Delete Document", "Are you sure? This will delete the document and wipe it from David's memory.", true);
    if (!confirmed) return;

    // 🔥 OPTIMISTIC UPDATE
    const docRow = document.querySelector(`#menu-${docId}`).closest('.doc-row');
    if (docRow) docRow.remove();

    try {
       const res = await fetch("/api/documents/" + docId, { 
            method: 'DELETE', headers: { 'Content-Type': 'application/json' } 
        });
        const data = await res.json();
        if (!data.success) throw new Error("Delete failed");
        showToast("Document deleted.");
    } catch (e) { 
        showToast("Failed to delete document.", "error");
        loadUserDocuments(); // Revert UI if server fails
    }
}

async function loadUserDocuments() {
    if (!globalUserId) return;
    try {
       const res = await fetch("/api/documents", { 
            cache: "no-store" 
        });
        const data = await res.json();
        const list = document.getElementById('documentList');

        if (data.success && data.documents && data.documents.length > 0) {
            list.innerHTML = "";
            
            // 💾 Pull saved selections from memory
            const savedSelections = JSON.parse(localStorage.getItem('david_saved_docs_' + globalUserId) || "[]");

            data.documents.forEach(doc => {
                let dateStr = "";
                if (doc.uploaded_at) {
                    const d = new Date(doc.uploaded_at);
                    dateStr = d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
                }
                
                const safeName = escapeHtml(doc.document_name);
                const escapedForFunc = safeName.replace(/'/g, "\\'").replace(/"/g, "&quot;");
                
                // 💾 See if this doc was previously checked
                const isChecked = savedSelections.includes(doc.id) ? "checked" : "";

                list.innerHTML += `
                    <div class="doc-row">
                        <label class="doc-label" title="${safeName}">
                            <input type="checkbox" class="doc-checkbox" value="${doc.id}" style="margin-top:2px;" onchange="handleDocSelection(this)" ${isChecked} />
                            ${getFileIcon(doc.document_name)}
                            <div class="doc-info">
                                <span class="doc-name">${safeName}</span>
                                <span class="doc-date">${dateStr}</span>
                            </div>
                        </label>
                        
                        <div class="doc-menu-wrapper">
                            <button class="doc-menu-btn" onclick="toggleDocMenu(event, '${doc.id}')">⋮</button>
                            <div class="doc-dropdown" id="menu-${doc.id}">
                                <button onclick="viewDocument('${doc.id}')">View Text</button>
                                <button onclick="renameDocument('${doc.id}', '${escapedForFunc}')">Rename File</button>
                                <button class="delete-btn" onclick="deleteDocument('${doc.id}')">Delete File</button>
                            </div>
                        </div>
                    </div>
                `;
            });
            filterDocs(); // Re-apply search filter if actively typing
        } else {
            list.innerHTML = '<div style="padding:20px;color:#666;font-size:13px;text-align:center;">No documents yet.</div>';
        }
    } catch (e) { 
        console.error("Failed to load docs:", e); 
    }
}

// Guard the Deep Dive Toggle
function handleToggleChange(toggle) {
    const checkedBoxes = document.querySelectorAll('.doc-checkbox:checked');
    
    // If they try to turn Deep Dive ON while > 2 docs are selected
    if (toggle.checked && checkedBoxes.length > 2) {
        uiAlert("Notice", "Deep Dive mode can only process up to 2 documents at a time. Please uncheck some documents first.");
        toggle.checked = false; // Instantly flip the toggle back off
    }
}

// Save selections and enforce dynamic limits
function handleDocSelection(checkbox) {
    const checkedBoxes = document.querySelectorAll('.doc-checkbox:checked');
    const isDeepDive = document.getElementById('deepDiveToggle').checked;
    
    // Enforce the 2-file limit ONLY if Deep Dive is currently ON
    if (isDeepDive && checkedBoxes.length > 2) {
        uiAlert("Notice", "Deep Dive mode can only process a maximum of 2 documents at a time.");
        checkbox.checked = false; // Uncheck the box they just clicked
        return;
    }

    // Save the current selections to LocalStorage (works for unlimited docs if Deep Dive is OFF)
    const selectedDocIds = Array.from(document.querySelectorAll('.doc-checkbox:checked')).map(cb => cb.value);
    localStorage.setItem('david_saved_docs_' + globalUserId, JSON.stringify(selectedDocIds));
}


// ==========================================
// DROPDOWN & PROFILE MANAGEMENT
// ==========================================
function toggleProfileMenu(event) {
    event.stopPropagation();
    
    const container = event.currentTarget.closest('.profile-dropdown-container');
    const menu = container.querySelector('.profile-dropdown-menu');
    const btn = container.querySelector('.profile-trigger-btn');
    
    // Close all other menus
    document.querySelectorAll('.profile-dropdown-menu.show').forEach(m => {
        if (m !== menu) m.classList.remove('show');
    });
    document.querySelectorAll('.profile-trigger-btn.active').forEach(b => {
        if (b !== btn) b.classList.remove('active');
    });

    menu.classList.toggle('show');
    btn.classList.toggle('active');
}

// Close dropdown if clicking outside
document.addEventListener('click', (e) => {
    if (!e.target.closest('.profile-dropdown-container')) {
        document.querySelectorAll('.profile-dropdown-menu.show').forEach(m => m.classList.remove('show'));
        document.querySelectorAll('.profile-trigger-btn.active').forEach(b => b.classList.remove('active'));
    }
});

async function openProfileModal() {
    document.querySelectorAll('.profile-dropdown-menu.show').forEach(m => m.classList.remove('show'));
    document.querySelectorAll('.profile-trigger-btn.active').forEach(b => b.classList.remove('active'));
    
    const modal = document.getElementById('profileModal');
    const nameInput = document.getElementById('profileNameInput');
    const emailInput = document.getElementById('profileEmailInput');
    const loginDisplay = document.getElementById('lastLoginDisplay');
    const formatSecurityTime = (value, emptyText) => {
        if (!value || value === "null" || value === "undefined" || value === "First time logging in") return emptyText;
        const d = new Date(value);
        if (Number.isNaN(d.getTime())) return emptyText;
        return d.toLocaleDateString() + " at " + d.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    };
    const renderSecurityHistory = (webLogin, lastCall) => {
        const webText = formatSecurityTime(webLogin, "This is your first web session");
        const callText = formatSecurityTime(lastCall, "No calls recorded yet");
        loginDisplay.innerHTML = `<div>Last web login: ${escapeHtml(webText)}</div><div>Last call: ${escapeHtml(callText)}</div>`;
    };
    
    // Format previous login
    const prev = localStorage.getItem('david_previous_login');
    renderSecurityHistory(prev, null);

    nameInput.value = "Loading...";
    emailInput.value = "Loading...";
    modal.classList.add('show');

    try {
        const res = await fetch('/api/web/profile');
        const data = await res.json();
        if (data.success) {
            nameInput.value = (data.profile.full_name && data.profile.full_name !== 'null') ? data.profile.full_name : "";
            emailInput.value = (data.profile.email && data.profile.email !== 'null') ? data.profile.email : "";
            
            // 🕰️ Evaluate Strict Web Login Trail
            const prev = localStorage.getItem('david_previous_login');
            const webLogin = (prev && prev !== "First time logging in" && prev !== "null" && prev !== "undefined")
                ? prev
                : data.profile.last_web_login;
            renderSecurityHistory(webLogin, data.profile.last_call_at);
        }
    } catch (e) {
        nameInput.value = ""; emailInput.value = "";
        loginDisplay.innerText = "Could not load account activity.";
    }
}

function closeProfileModal() {
    document.getElementById('profileModal').classList.remove('show');
}

async function saveProfileSettings() {
    const name = document.getElementById('profileNameInput').value.trim();
    const email = document.getElementById('profileEmailInput').value.trim();
    const btn = document.getElementById('saveProfileBtn');
    
    btn.innerText = "Saving...";
    btn.disabled = true;

    try {
       const res = await fetch('/api/web/profile', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, email })
        });
        const data = await res.json();
        if (data.success) {
            // Update the top right UI name instantly!
            if (name) {
                const firstName = name.split(' ')[0];
                document.querySelectorAll('.login-tag-text').forEach(el => el.innerText = "Logged in as " + firstName);
                localStorage.setItem('david_userName', firstName);
            }
            closeProfileModal();
        } else {
            uiAlert("Error", "Failed to save profile.");
        }
    } catch (e) {
        uiAlert("Error", "Network connection failed.");
    } finally {
        btn.innerText = "Save Changes";
        btn.disabled = false;
    }
}

// ==========================================
// COPY TO CLIPBOARD
// ==========================================
function copyMessageText(btn, encodedText) {
    const text = decodeURIComponent(encodedText);
    navigator.clipboard.writeText(text).then(() => {
        showToast("Copied to clipboard!");
    }).catch(err => showToast("Copy failed", "error"));
}


async function uploadDocument(droppedFile = null) {
    const fileInput = document.getElementById('fileInput');
    const status = document.getElementById('uploadStatus');
    const btn = document.getElementById('uploadBtn');

    // Automatically decide whether to use the dropped file or the file picker
    let fileToUpload = droppedFile;
    if (!fileToUpload && fileInput.files.length > 0) {
        fileToUpload = fileInput.files[0];
    }

    if (!fileToUpload) { 
        status.innerText = "Select a file first."; 
        return; 
    }

    const formData = new FormData();
    formData.append("document", fileToUpload);

    status.innerText = "Analyzing and building memory chunks...";
    status.style.color = "#888";
    btn.disabled = true;
    btn.innerText = "Uploading...";

    try {
        const res = await fetch('/api/upload', { 
            method: 'POST', 
            body: formData 
        });
        const data = await res.json();
        if (data.success) {
            showToast("Document saved and memorized!");
            status.innerText = "";
            fileInput.value = ""; // Clear the picker if it was used
            loadUserDocuments();
        } else { 
            showToast(data.error, "error");
            status.innerText = "";
        }
    } catch (e) { 
        showToast("Failed to upload.", "error");
        status.innerText = "";
    }
    btn.disabled = false;
    btn.innerText = "Upload Document";
}

// ==========================================
// IOS SAFARI KEYBOARD GLITCH FIX
// ==========================================
// Forces the viewport to redraw and snap back into place when the keyboard closes
document.addEventListener('focusout', function(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
        setTimeout(() => {
            window.scrollTo(0, 0);
        }, 100); // 100ms gives the keyboard time to fully retract
    }
});


// ==========================================
// SESSION INACTIVITY TRACKER
// ==========================================
let activityTimeout = null;

function resetInactivityTimer() {
    // Only track activity if the user is actually logged in
    if (globalUserId) {
        localStorage.setItem('david_last_active', Date.now());
        
       // Optional active session check: If they somehow bypassed the boot check 
        // and try to click around after 16h, kick them out immediately.
        const lastActive = localStorage.getItem('david_last_active');
        if (lastActive && (Date.now() - parseInt(lastActive) > 16 * 60 * 60 * 1000)) {
            uiAlert("Session Expired", "You have been logged out due to 16 hours of inactivity.");
            logoutUser();
        }
    }
}

// Listen for interactions, but throttle the updates to once per minute 
// so we don't spam the browser's local storage engine on every mouse movement.
['click', 'touchstart', 'keypress', 'scroll'].forEach(evt => {
    document.addEventListener(evt, () => {
        if (activityTimeout) return;
        
        activityTimeout = setTimeout(() => {
            resetInactivityTimer();
            activityTimeout = null;
        }, 60000); // 1-minute throttle
        
    }, { passive: true });
});


// ==========================================
// VOICE-TO-TEXT (WHISPER)
// ==========================================
let mediaRecorder;
let audioChunks = [];
let isRecording = false;

async function toggleRecording() {
    const micBtn = document.getElementById('micBtn');
    const chatInput = document.getElementById('chatInput');

    // If already recording, STOP and SEND
    if (isRecording) {
        mediaRecorder.stop();
    isRecording = false;
        micBtn.classList.remove('recording');
        micBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="22"></line></svg>`;
        chatInput.placeholder = "Transcribing voice...";
        chatInput.disabled = true;
        return;
    }

    // Start Recording
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream);
        audioChunks = [];

        mediaRecorder.ondataavailable = event => {
            if (event.data.size > 0) audioChunks.push(event.data);
        };

        mediaRecorder.onstop = async () => {
            const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
            const formData = new FormData();
            formData.append('audio', audioBlob, 'voice.webm');

            try {
                const res = await fetch('/api/transcribe', {
                    method: 'POST',
                    body: formData
                });
                const data = await res.json();
                
                if (data.success && data.text.trim().length > 0) {
                    chatInput.value = data.text;
                    sendMessage(); // Automatically send the message!
                } else if (!data.success) {
                    uiAlert("Error", data.error || "Could not transcribe audio.");
                }
            } catch(e) {
                console.error(e);
                uiAlert("Error", "Network error during transcription.");
            } finally {
                // Reset input field
                chatInput.disabled = false;
                chatInput.placeholder = "Ask David a question...";
                chatInput.focus();
            }

            // Turn off the microphone hardware indicator in the browser tab
            stream.getTracks().forEach(track => track.stop());
        };

        mediaRecorder.start();
        isRecording = true;
        micBtn.classList.add('recording');
        micBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12"></rect></svg>`;
        chatInput.placeholder = "Listening... (Tap Stop when done)";
    } catch (err) {
        console.error("Microphone access denied:", err);
        uiAlert("Microphone Access", "Please allow microphone access in your browser settings to use voice typing.");
    }
}

// ==========================================
// DRAG AND DROP FILE UPLOADS
// ==========================================
document.addEventListener("DOMContentLoaded", () => {
    setupDragAndDrop('.chat-area', 'chatDragOverlay');
    setupDragAndDrop('.right-sidebar', 'kbDragOverlay');
});

function setupDragAndDrop(containerSelector, overlayId) {
    const container = document.querySelector(containerSelector);
    const overlay = document.getElementById(overlayId);
    if (!container || !overlay) return;

    let dragCounter = 0; // Prevents flickering when dragging over child elements like text

    container.addEventListener('dragenter', (e) => {
        e.preventDefault();
        dragCounter++;
        overlay.classList.add('active');
    });

    container.addEventListener('dragleave', (e) => {
        e.preventDefault();
        dragCounter--;
        if (dragCounter === 0) {
            overlay.classList.remove('active');
        }
    });

    container.addEventListener('dragover', (e) => {
        e.preventDefault(); // Critical: allows the 'drop' event to fire
    });

    container.addEventListener('drop', (e) => {
        e.preventDefault();
        dragCounter = 0;
        overlay.classList.remove('active');
        
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            const file = e.dataTransfer.files[0];
            uploadDocument(file); // Pass the dropped file directly to our uploader
        }
    });
}

// 🆕 Syncs the UI with your Supabase profile name
async function syncUserIdentity() {
    try {
        const res = await fetch('/api/web/profile');
        const data = await res.json();
        
        // Only update if a valid name is found in the database
        // 🚨 FIX: Only update the UI if the name is NOT "Guest" and NOT "null"
        if (data.success && data.profile && data.profile.full_name) {
            const dbName = data.profile.full_name.toLowerCase();
            if (dbName !== 'null' && dbName !== 'guest' && dbName !== 'unknown' && dbName !== '') {
                userName = data.profile.full_name.split(' ')[0];
                document.querySelectorAll('.login-tag-text').forEach(el => el.innerText = "Logged in as " + userName);
                localStorage.setItem('david_userName', userName);
                console.log("✅ UI Identity Synced:", userName);
            }
        }
    } catch (e) { 
        console.log("Identity sync failed:", e); 
    }
}
