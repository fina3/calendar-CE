// Popup script for Text to Calendar extension

document.addEventListener('DOMContentLoaded', () => {
  const eventsList = document.getElementById('events-list');
  const emptyState = document.getElementById('empty-state');
  const clearBtn = document.getElementById('clear-btn');
  const confirmModal = document.getElementById('confirm-modal');
  const confirmCancel = document.getElementById('confirm-cancel');
  const confirmClear = document.getElementById('confirm-clear');

  const EVENT_LIMIT = 5;
  const REMOVE_ANIMATION_MS = 200;

  // Timers started by card removal, cleared if the list is re-rendered (or the
  // popup closes) before they fire so no callback ever runs against a detached
  // card.
  const pendingRemovals = new Set();

  // The footer button would otherwise flash before the first render decides
  // whether there is any history to clear.
  clearBtn.style.display = 'none';

  loadRecentEvents();

  clearBtn.addEventListener('click', () => {
    showModal();
  });

  confirmCancel.addEventListener('click', () => {
    hideModal();
  });

  confirmClear.addEventListener('click', async () => {
    hideModal();
    await clearHistory();
  });

  // Close modal on background click
  confirmModal.addEventListener('click', (e) => {
    if (e.target === confirmModal) {
      hideModal();
    }
  });

  // Close modal on Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && confirmModal.classList.contains('visible')) {
      hideModal();
    }
  });

  // Keep the list in step with events created while the popup is open
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.recentEvents) {
      renderEvents(sanitize(changes.recentEvents.newValue).slice(0, EVENT_LIMIT));
    }
  });

  window.addEventListener('pagehide', clearPendingRemovals);

  /**
   * Ask the background worker for data, falling back to direct storage reads.
   * sendMessage rejects (or resolves undefined) whenever the service worker is
   * still starting up, so every caller has to cope with a missing response.
   */
  async function sendMessage(message) {
    try {
      const response = await chrome.runtime.sendMessage(message);
      return response || { success: false, error: 'No response from background worker' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Drop anything that is not a usable event record
   */
  function sanitize(events) {
    if (!Array.isArray(events)) {
      return [];
    }
    return events.filter((event) => event && typeof event === 'object' && typeof event.id === 'string');
  }

  /**
   * Load recent events using the message API
   */
  async function loadRecentEvents() {
    const response = await sendMessage({ action: 'getRecentEvents', limit: EVENT_LIMIT });

    if (response.success) {
      renderEvents(sanitize(response.events));
      return;
    }

    console.error('Failed to load events:', response.error);

    // Fallback to direct storage access if the message failed
    try {
      const result = await chrome.storage.local.get(['recentEvents']);
      renderEvents(sanitize(result.recentEvents).slice(0, EVENT_LIMIT));
    } catch (fallbackError) {
      console.error('Could not read event history:', fallbackError);
      renderEvents([]);
    }
  }

  function clearPendingRemovals() {
    for (const timer of pendingRemovals) {
      clearTimeout(timer);
    }
    pendingRemovals.clear();
  }

  /**
   * Render events list
   */
  function renderEvents(events) {
    clearPendingRemovals();
    eventsList.replaceChildren();

    if (events.length === 0) {
      emptyState.classList.add('visible');
      clearBtn.style.display = 'none';
      return;
    }

    emptyState.classList.remove('visible');
    clearBtn.style.display = 'block';

    const fragment = document.createDocumentFragment();
    events.forEach((event, index) => {
      fragment.appendChild(createEventCard(event, index));
    });
    eventsList.appendChild(fragment);
  }

  /**
   * Create an event card element
   */
  function createEventCard(event, index) {
    const card = document.createElement('div');
    card.className = 'event-card';
    card.style.animationDelay = `${index * 0.05}s`;
    card.dataset.eventId = event.id;

    // Title
    const title = document.createElement('div');
    title.className = 'event-title';
    title.textContent = event.title || '(untitled)';
    title.title = event.originalText || event.title || '';

    // Date and confidence indicator
    const meta = document.createElement('div');
    meta.className = 'event-meta';

    const date = document.createElement('div');
    date.className = 'event-date';
    date.textContent = formatEventDate(event.startDate);

    meta.appendChild(date);

    // Add confidence indicator if available
    if (typeof event.confidence === 'number') {
      const confidence = document.createElement('div');
      confidence.className = 'event-confidence';
      confidence.title = `Parse confidence: ${Math.round(event.confidence * 100)}%`;

      const confidenceLevel = event.confidence >= 0.7 ? 'high' :
        event.confidence >= 0.4 ? 'medium' : 'low';
      confidence.classList.add(`confidence-${confidenceLevel}`);
      confidence.textContent = confidenceLevel === 'high' ? '✓' :
        confidenceLevel === 'medium' ? '~' : '?';
      meta.appendChild(confidence);
    }

    // Buttons container
    const buttons = document.createElement('div');
    buttons.className = 'event-buttons';

    // Create Again button
    const createBtn = document.createElement('button');
    createBtn.className = 'btn-create-again';
    createBtn.textContent = 'Create Again';
    createBtn.addEventListener('click', () => {
      createAgain(event);
    });

    // Delete button
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn-delete';
    deleteBtn.textContent = '×';
    deleteBtn.title = 'Remove from history';
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteBtn.disabled = true;
      deleteEvent(event.id, card, deleteBtn);
    });

    buttons.appendChild(createBtn);
    buttons.appendChild(deleteBtn);

    card.appendChild(title);
    card.appendChild(meta);
    card.appendChild(buttons);

    return card;
  }

  /**
   * Format date for display
   */
  function formatEventDate(dateString) {
    const date = new Date(dateString);
    if (isNaN(date.getTime())) {
      return 'Unknown date';
    }

    const now = new Date();

    const timeStr = date.toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit'
    });

    const dayOffset = Math.round(
      (startOfDay(date) - startOfDay(now)) / (24 * 60 * 60 * 1000)
    );

    if (dayOffset === 0) {
      return `Today at ${timeStr}`;
    }
    if (dayOffset === 1) {
      return `Tomorrow at ${timeStr}`;
    }
    if (dayOffset === -1) {
      return `Yesterday at ${timeStr}`;
    }

    const dateStr = date.toLocaleDateString([], {
      weekday: 'short',
      month: 'short',
      day: 'numeric'
    });

    return `${dateStr} at ${timeStr}`;
  }

  function startOfDay(date) {
    const copy = new Date(date);
    copy.setHours(0, 0, 0, 0);
    return copy;
  }

  /**
   * Handle "Create Again" click
   */
  function createAgain(event) {
    if (typeof event.calendarUrl === 'string' && event.calendarUrl.startsWith('https://calendar.google.com/')) {
      chrome.tabs.create({ url: event.calendarUrl });
    } else {
      console.error('Event has no usable calendar URL');
    }
  }

  /**
   * Delete a specific event
   */
  async function deleteEvent(eventId, cardElement, deleteBtn) {
    cardElement.classList.add('removing');

    const response = await sendMessage({ action: 'deleteEvent', id: eventId });

    if (!response.success || !response.deleted) {
      cardElement.classList.remove('removing');
      deleteBtn.disabled = false;
      console.error('Failed to delete event:', response.error || 'not found');
      return;
    }

    // Let the removal animation finish, then reload so an older event can take
    // the freed slot instead of leaving the list short.
    const timer = setTimeout(() => {
      pendingRemovals.delete(timer);
      loadRecentEvents();
    }, REMOVE_ANIMATION_MS);
    pendingRemovals.add(timer);
  }

  /**
   * Show confirmation modal
   */
  function showModal() {
    confirmModal.classList.add('visible');
    confirmClear.focus();
  }

  /**
   * Hide confirmation modal
   */
  function hideModal() {
    confirmModal.classList.remove('visible');
    clearBtn.focus();
  }

  /**
   * Clear all history using the message API
   */
  async function clearHistory() {
    const response = await sendMessage({ action: 'clearHistory' });

    if (response.success) {
      renderEvents([]);
      return;
    }

    console.error('Failed to clear history:', response.error);

    // Fallback to direct storage access
    try {
      await chrome.storage.local.set({ recentEvents: [] });
      renderEvents([]);
    } catch (fallbackError) {
      console.error('Could not clear history:', fallbackError);
    }
  }
});
