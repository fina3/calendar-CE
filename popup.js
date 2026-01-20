// Popup script for Text to Calendar extension

document.addEventListener("DOMContentLoaded", () => {
  const eventsList = document.getElementById("events-list");
  const emptyState = document.getElementById("empty-state");
  const clearBtn = document.getElementById("clear-btn");
  const confirmModal = document.getElementById("confirm-modal");
  const confirmCancel = document.getElementById("confirm-cancel");
  const confirmClear = document.getElementById("confirm-clear");

  // Load and render recent events
  loadRecentEvents();

  // Clear history button
  clearBtn.addEventListener("click", () => {
    showModal();
  });

  // Modal cancel
  confirmCancel.addEventListener("click", () => {
    hideModal();
  });

  // Modal confirm clear
  confirmClear.addEventListener("click", async () => {
    await clearHistory();
    hideModal();
  });

  // Close modal on background click
  confirmModal.addEventListener("click", (e) => {
    if (e.target === confirmModal) {
      hideModal();
    }
  });

  // Close modal on Escape key
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && confirmModal.classList.contains("visible")) {
      hideModal();
    }
  });

  /**
   * Load recent events using message API
   */
  async function loadRecentEvents() {
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'getRecentEvents',
        limit: 5
      });

      if (response.success) {
        renderEvents(response.events);
      } else {
        console.error("Failed to load events:", response.error);
        renderEvents([]);
      }
    } catch (error) {
      console.error("Error loading events:", error);
      // Fallback to direct storage access if message fails
      try {
        const result = await chrome.storage.local.get(["recentEvents"]);
        renderEvents(result.recentEvents || []);
      } catch (fallbackError) {
        console.error("Fallback also failed:", fallbackError);
        renderEvents([]);
      }
    }
  }

  /**
   * Render events list
   */
  function renderEvents(events) {
    eventsList.innerHTML = "";

    if (events.length === 0) {
      emptyState.classList.add("visible");
      clearBtn.style.display = "none";
      return;
    }

    emptyState.classList.remove("visible");
    clearBtn.style.display = "block";

    events.forEach((event, index) => {
      const card = createEventCard(event, index);
      eventsList.appendChild(card);
    });
  }

  /**
   * Create an event card element
   */
  function createEventCard(event, index) {
    const card = document.createElement("div");
    card.className = "event-card";
    card.style.animationDelay = `${index * 0.05}s`;
    card.dataset.eventId = event.id;

    // Title
    const title = document.createElement("div");
    title.className = "event-title";
    title.textContent = event.title;
    title.title = event.originalText || event.title;

    // Date and confidence indicator
    const meta = document.createElement("div");
    meta.className = "event-meta";

    const date = document.createElement("div");
    date.className = "event-date";
    date.textContent = formatEventDate(event.startDate);

    meta.appendChild(date);

    // Add confidence indicator if available
    if (typeof event.confidence === 'number') {
      const confidence = document.createElement("div");
      confidence.className = "event-confidence";
      confidence.title = `Parse confidence: ${Math.round(event.confidence * 100)}%`;

      const confidenceLevel = event.confidence >= 0.7 ? 'high' :
                              event.confidence >= 0.4 ? 'medium' : 'low';
      confidence.classList.add(`confidence-${confidenceLevel}`);
      confidence.textContent = confidenceLevel === 'high' ? '✓' :
                               confidenceLevel === 'medium' ? '~' : '?';
      meta.appendChild(confidence);
    }

    // Buttons container
    const buttons = document.createElement("div");
    buttons.className = "event-buttons";

    // Create Again button
    const createBtn = document.createElement("button");
    createBtn.className = "btn-create-again";
    createBtn.textContent = "Create Again";
    createBtn.addEventListener("click", () => {
      createAgain(event);
    });

    // Delete button
    const deleteBtn = document.createElement("button");
    deleteBtn.className = "btn-delete";
    deleteBtn.textContent = "×";
    deleteBtn.title = "Remove from history";
    deleteBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await deleteEvent(event.id, card);
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
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const timeStr = date.toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit"
    });

    // Check if today
    if (date.toDateString() === now.toDateString()) {
      return `Today at ${timeStr}`;
    }

    // Check if tomorrow
    if (date.toDateString() === tomorrow.toDateString()) {
      return `Tomorrow at ${timeStr}`;
    }

    // Check if yesterday
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) {
      return `Yesterday at ${timeStr}`;
    }

    // Otherwise show full date
    const dateStr = date.toLocaleDateString([], {
      weekday: "short",
      month: "short",
      day: "numeric"
    });

    return `${dateStr} at ${timeStr}`;
  }

  /**
   * Handle "Create Again" click
   */
  function createAgain(event) {
    if (event.calendarUrl) {
      chrome.tabs.create({ url: event.calendarUrl });
    }
  }

  /**
   * Delete a specific event
   */
  async function deleteEvent(eventId, cardElement) {
    try {
      // Add removing animation
      cardElement.classList.add("removing");

      const response = await chrome.runtime.sendMessage({
        action: 'deleteEvent',
        id: eventId
      });

      if (response.success && response.deleted) {
        // Wait for animation then remove
        setTimeout(() => {
          cardElement.remove();
          // Check if list is now empty
          if (eventsList.children.length === 0) {
            emptyState.classList.add("visible");
            clearBtn.style.display = "none";
          }
        }, 200);
      } else {
        cardElement.classList.remove("removing");
        console.error("Failed to delete event");
      }
    } catch (error) {
      cardElement.classList.remove("removing");
      console.error("Error deleting event:", error);
    }
  }

  /**
   * Show confirmation modal
   */
  function showModal() {
    confirmModal.classList.add("visible");
    confirmClear.focus();
  }

  /**
   * Hide confirmation modal
   */
  function hideModal() {
    confirmModal.classList.remove("visible");
  }

  /**
   * Clear all history using message API
   */
  async function clearHistory() {
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'clearHistory'
      });

      if (response.success) {
        renderEvents([]);
      } else {
        console.error("Failed to clear history:", response.error);
      }
    } catch (error) {
      console.error("Error clearing history:", error);
      // Fallback to direct storage access
      try {
        await chrome.storage.local.set({ recentEvents: [] });
        renderEvents([]);
      } catch (fallbackError) {
        console.error("Fallback also failed:", fallbackError);
      }
    }
  }
});
