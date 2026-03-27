// ==========================================
// STATE VARIABLES
// ==========================================
let globalUserId = "";
let userPhone = "";
let globalConversations = [];
let currentConversationId = null;
let userName = "Guest";
let isLoadingChat = false;
const botAvatar = "/avatar.jpg";

const phoneInputField = document.querySelector("#phoneInput");
const phoneInput = window.intlTelInput(phoneInputField, {
    utilsScript: "https://cdnjs.cloudflare.com/ajax/libs/intl-tel-input/17.0.8/js/utils.js",
    preferredCountries: ["ca", "us", "gb", "au"],
    separateDialCode: true
});

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
window.addEventListener('DOMContentLoaded', () => {
    // 1. Mobile Tab Default
    if (window.innerWidth <= 768) {
        document.querySelector('.chat-area').classList.add('mobile-active');
    }

    // 2. Auto-Login Check
    const savedUserId = localStorage.getItem('david_userId');
    if (savedUserId) {
        globalUserId = savedUserId;
        userName = localStorage.getItem('david_userName') || "Guest";
        userPhone = localStorage.getItem('david_userPhone') || "";
        
        document.getElementById('loginTag').innerText = "Logged in as " + userName;
        document.getElementById('loginContainer').style.display = 'none';
        document.getElementById('dashboardContainer').style.display = 'flex';
        initDashboard(); // Boot up the app instantly!
    }
});

// ==========================================
// AUTHENTICATION
// ==========================================
async function sendCode() {
    userPhone = phoneInput.getNumber();
    if (!userPhone) { alert("Please enter a valid phone number."); return; }
    const btn = document.querySelector('#step1 .btn');
    btn.innerText = "Sending...";
    try {
        const res = await fetch('/api/auth/send-code', {
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: userPhone })
        });
        const data = await res.json();
        if (data.success) {
            document.getElementById('step1').style.display = 'none';
            document.getElementById('step2').style.display = 'block';
        } else { 
            alert(data.error); 
            btn.innerText = "Send Secure Code"; 
        }
    } catch (e) { 
        alert("Connection error."); 
        btn.innerText = "Send Secure Code"; 
    }
}

async function verifyCode() {
    const code = document.getElementById('codeInput').value.trim();
    if (!code) return;
    const btn = document.querySelector('#step2 .btn');
    btn.innerText = "Verifying...";
    try {
        const res = await fetch('/api/auth/verify-code', {
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: userPhone, code })
        });
        const data = await res.json();
        if (data.success) {
            if (data.success) {
            globalUserId = data.userId;
            userName = (data.name && data.name.toLowerCase() !== "null") ? data.name.split(' ')[0] : "Guest";
            
            // --- NEW: Save to Local Storage ---
            localStorage.setItem('david_userId', globalUserId);
            localStorage.setItem('david_userName', userName);
            localStorage.setItem('david_userPhone', userPhone);
            // ----------------------------------

            document.getElementById('loginTag').innerText = "Logged in as " + userName;
            document.getElementById('loginContainer').style.display = 'none';
            document.getElementById('dashboardContainer').style.display = 'flex';
            await initDashboard();
        }
        } else { 
            alert(data.error); 
            btn.innerText = "Login to Portal"; 
        }
    } catch (e) { 
        alert("Connection error."); 
        btn.innerText = "Login to Portal"; 
    }
}

function logoutUser() {
    // Notify backend of logout to instantly trigger the welcome SMS (if applicable)
    if (globalUserId) {
        fetch('/api/web/logout', { 
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: globalUserId }) 
        }).catch(e => console.error("Logout ping failed", e));
    }

    globalUserId = "";
    userPhone = "";
    currentConversationId = null;
    
    // --- NEW: Clear Local Storage ---
    localStorage.removeItem('david_userId');
    localStorage.removeItem('david_userName');
    localStorage.removeItem('david_userPhone');
    // --------------------------------

    document.getElementById('dashboardContainer').style.display = 'none';
    
    // 🔥 THE FIX: Change this to 'flex' so the login layout doesn't break!
    document.getElementById('loginContainer').style.display = 'flex'; 
    document.getElementById('step2').style.display = 'none';
    document.getElementById('step1').style.display = 'block';
    document.getElementById('codeInput').value = "";
    document.querySelector('#step1 .btn').innerText = "Send Secure Code";
    document.querySelector('#step2 .btn').innerText = "Login to Portal";
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
}

// ==========================================
// CREATE NEW CHAT
// ==========================================
async function startNewChat() {
    try {
        const res = await fetch('/api/web/conversations/new', {
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: globalUserId })
        });
        const data = await res.json();
        if (data.success) {
            currentConversationId = data.conversationId;
            document.getElementById('chatMessages').innerHTML = "";
            showEmptyState();
            await loadConversationList(false);
            document.querySelectorAll('.chat-item').forEach(el => {
                el.classList.toggle('active', el.dataset.id === currentConversationId);
            });
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
        
        const previewText = c.preview || "New conversation";
        const safePreview = escapeHtml(previewText);
        const escapedForFunc = safePreview.replace(/'/g, "\\'").replace(/"/g, "&quot;");
        
        // 📞 Add a high-visibility badge if it was a voice call!
        const displayTitle = c.channel === 'call' 
            ? `<span style="background: rgba(76, 175, 80, 0.2); color: #4caf50; padding: 2px 6px; border-radius: 4px; font-size: 10px; margin-right: 6px; font-weight: 600; letter-spacing: 0.5px; vertical-align: middle;">📞 VOICE</span><span style="vertical-align: middle;">${safePreview}</span>` 
            : safePreview;

        item.innerHTML = `
            <div class="chat-item-text" onclick="switchChat('${c.id}')">
                <div class="chat-item-title">${displayTitle}</div>
                <span class="chat-item-date">${dateStr}</span>
            </div>
            <div class="chat-actions-container">
                <button class="chat-action-btn" onclick="event.stopPropagation(); renameChat('${c.id}', '${escapedForFunc}')" title="Rename chat">✏️</button>
                <button class="chat-action-btn chat-delete-btn" onclick="event.stopPropagation(); deleteChat('${c.id}')" title="Delete chat">×</button>
            </div>
        `;
        list.appendChild(item);
    });
}

// 🌐 LOAD CONVERSATIONS (UPDATED FOR FILTERS)
async function loadConversationList(autoSelect = false) {
    try {
        const res = await fetch("/api/web/conversations?userId=" + globalUserId, { cache: "no-store" });
        const data = await res.json();
        
        if (data.success && data.conversations) {
            globalConversations = data.conversations;
        } else {
            globalConversations = [];
        }
        
        renderConversations();

        if (autoSelect && !currentConversationId && globalConversations.length > 0) {
            await switchChat(globalConversations[0].id);
        }
    } catch (e) {
        console.error("Failed to load conversation list:", e);
    }
}

// ==========================================
// RENAME & SWITCH CHAT
// ==========================================
async function renameChat(conversationId, currentTitle) {
    const newTitle = prompt("Enter a new name for this chat (leave blank to auto-generate):", currentTitle === 'New conversation' ? '' : currentTitle);
    if (newTitle === null) return;
    try {
        const res = await fetch(`/api/web/conversations/${conversationId}/title`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: globalUserId, title: newTitle })
        });
        const data = await res.json();
        if (data.success) {
            await loadConversationList(false); 
        } else alert("Failed to rename chat.");
    } catch (e) { console.error("Rename error:", e); }
}

async function switchChat(conversationId) {
    if (isLoadingChat) return;
    if (conversationId === currentConversationId && document.getElementById('chatMessages').children.length > 0) return;
    
    isLoadingChat = true;
    currentConversationId = conversationId;

    document.querySelectorAll('.chat-item').forEach(el => {
        el.classList.toggle('active', el.dataset.id === conversationId);
    });

    const msgContainer = document.getElementById('chatMessages');
    msgContainer.innerHTML = '<div style="text-align:center;padding:40px;color:#bbb;">Loading messages...</div>';

    try {
        const res = await fetch(`/api/web/messages?userId=${globalUserId}&conversationId=${conversationId}`, { cache: "no-store" });
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
    if (!confirm("Delete this conversation permanently?")) return;
    try {
        const res = await fetch("/api/web/conversations/" + conversationId, {
            method: 'DELETE', 
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: globalUserId })
        });
        const data = await res.json();
        if (data.success) {
            if (conversationId === currentConversationId) {
                currentConversationId = null;
                document.getElementById('chatMessages').innerHTML = "";
                showEmptyState();
            }
            await loadConversationList(currentConversationId === null);
        }
    } catch (e) { console.error("Delete chat error:", e); }
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

async function sendMessage() {
    const inputField = document.getElementById('chatInput');
    const message = inputField.value.trim();
    if (!message) return;
    if (!currentConversationId) {
        alert("Please select or create a chat first.");
        return;
    }

    const es = document.getElementById('emptyState');
    if (es) es.remove();

    const checkedBoxes = document.querySelectorAll('.doc-checkbox:checked');
    const selectedDocIds = Array.from(checkedBoxes).map(cb => cb.value);
    const isDeepDive = document.getElementById('deepDiveToggle').checked;

    addMessageToUI(message, 'user', selectedDocIds.length, isDeepDive);
    inputField.value = "";

    const sendBtn = document.getElementById('sendBtn');
    sendBtn.disabled = true;
    sendBtn.innerText = "...";

    // 🕒 SHOW TYPING ANIMATION
    showTyping();

    try {
        const res = await fetch('/api/chat', {
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: globalUserId,
                message,
                conversationId: currentConversationId,
                selectedDocIds,
                deepDive: isDeepDive
            })
        });
        const data = await res.json();

        // 🛑 REMOVE TYPING ANIMATION
        removeTyping();

        if (data.success) {
            addMessageToUI(data.reply, 'bot');
            if (data.conversationId) currentConversationId = data.conversationId;
            loadConversationList(false);
        } else {
            console.error("Chat error response:", data);
            addMessageToUI("Sorry, something went wrong. " + (data.error || ""), 'bot');
        }
    } catch (error) {
        console.error("Chat network error:", error);
        removeTyping(); // Ensure it is removed on a network crash too
        addMessageToUI("Network error. Please check your connection.", 'bot');
    }
    sendBtn.disabled = false;
    sendBtn.innerText = "Send";
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
            userHtml += `<span style="background: #e0f2fe; color: #0284c7; padding: 3px 8px; border-radius: 12px; font-size: 11px; font-weight: 500;">📎 ${fileCount} File(s)</span>`;
        }
        if (isDeepDive) {
            userHtml += `<span style="background: #fce7f3; color: #db2777; padding: 3px 8px; border-radius: 12px; font-size: 11px; font-weight: 500;">🤿 Deep Dive Active</span>`;
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

async function renameDocument(docId, oldName) {
    const newName = prompt("Enter a new name for this document:", oldName);
    if (!newName || newName.trim() === oldName) return;
    
    try {
        const res = await fetch(`/api/documents/${docId}/name`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: globalUserId, newName: newName.trim() })
        });
        const data = await res.json();
        if (data.success) {
            loadUserDocuments();
        } else alert("Failed to rename document.");
    } catch (e) { console.error("Rename doc error:", e); }
}

async function deleteDocument(docId) {
    if (!confirm("Are you sure? This will delete the document and all of its memory chunks permanently.")) return;
    try {
        const res = await fetch("/api/documents/" + docId, {
            method: 'DELETE', 
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: globalUserId })
        });
        const data = await res.json();
        if (data.success) loadUserDocuments();
    } catch (e) { console.error("Delete doc error:", e); }
}

async function loadUserDocuments() {
    if (!globalUserId) return;
    try {
        const res = await fetch("/api/documents?userId=" + globalUserId, { cache: "no-store" });
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
        alert("Deep Dive mode can only process up to 2 documents at a time. Please uncheck some documents first.");
        toggle.checked = false; // Instantly flip the toggle back off
    }
}

// Save selections and enforce dynamic limits
function handleDocSelection(checkbox) {
    const checkedBoxes = document.querySelectorAll('.doc-checkbox:checked');
    const isDeepDive = document.getElementById('deepDiveToggle').checked;
    
    // Enforce the 2-file limit ONLY if Deep Dive is currently ON
    if (isDeepDive && checkedBoxes.length > 2) {
        alert("Deep Dive mode can only process a maximum of 2 documents at a time.");
        checkbox.checked = false; // Uncheck the box they just clicked
        return;
    }

    // Save the current selections to LocalStorage (works for unlimited docs if Deep Dive is OFF)
    const selectedDocIds = Array.from(document.querySelectorAll('.doc-checkbox:checked')).map(cb => cb.value);
    localStorage.setItem('david_saved_docs_' + globalUserId, JSON.stringify(selectedDocIds));
}

// ==========================================
// COPY TO CLIPBOARD
// ==========================================
function copyMessageText(btn, encodedText) {
    const text = decodeURIComponent(encodedText);
    navigator.clipboard.writeText(text).then(() => {
        btn.innerHTML = "✅ Copied!";
        setTimeout(() => { btn.innerHTML = "📋 Copy"; }, 2000);
    }).catch(err => console.error("Copy failed", err));
}


async function uploadDocument() {
    const fileInput = document.getElementById('fileInput');
    const status = document.getElementById('uploadStatus');
    const btn = document.getElementById('uploadBtn');
    if (!fileInput.files.length) { 
        status.innerText = "Select a file first."; 
        return; 
    }

    const formData = new FormData();
    formData.append("userId", globalUserId);
    formData.append("document", fileInput.files[0]);

    status.innerText = "Analyzing and building memory chunks...";
    status.style.color = "#888";
    btn.disabled = true;
    btn.innerText = "Uploading...";

    try {
        const res = await fetch('/api/upload', { method: 'POST', body: formData });
        const data = await res.json();
        if (data.success) {
            status.innerText = "✅ Saved and Memorized";
            status.style.color = "#4CAF50";
            fileInput.value = "";
            loadUserDocuments();
            setTimeout(() => { status.innerText = ""; }, 3000);
        } else { 
            status.innerText = "❌ " + data.error; 
            status.style.color = "#ff4c4c"; 
        }
    } catch (e) { 
        status.innerText = "❌ Failed."; 
        status.style.color = "#ff4c4c"; 
    }
    btn.disabled = false;
    btn.innerText = "Upload Document";
}
