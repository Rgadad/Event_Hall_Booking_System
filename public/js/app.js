// API Base URL
const API_URL = '/api';

// Get Current User
async function getCurrentUser() {
  const token = sessionStorage.getItem('token');
  if (!token) return null;

  try {
    const response = await fetch(`${API_URL}/current-user`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await response.json();
    return data.success ? data.user : null;
  } catch (error) {
    console.error('Error getting current user:', error);
    return null;
  }
}

// Update Navbar based on user
async function updateNavbar() {
  const user = await getCurrentUser();
  const navLinks = document.querySelector('.navbar-nav');

  if (!navLinks) return;

  if (user) {
    let roleLink = '';
    if (user.role === 'owner') {
      roleLink = '<li><a href="/owner.html">Owner Panel</a></li>';
    } else if (user.role === 'admin') {
      roleLink = '<li><a href="/admin.html">Admin Panel</a></li>';
    }

    navLinks.innerHTML = `
      <li><a href="/index.html">Home</a></li>
      <li><a href="/halls.html">Halls</a></li>
      ${roleLink}
      <li><a href="/profile.html">Profile</a></li>
      <li><a href="#" onclick="logout(); return false;">Logout</a></li>
      <li><span style="opacity: 0.8;">Hello, ${user.name}</span></li>
    `;
  } else {
    navLinks.innerHTML = `
      <li><a href="/index.html">Home</a></li>
      <li><a href="/halls.html">Halls</a></li>
      <li><a href="/login.html">Login</a></li>
      <li><a href="/signup.html">Sign Up</a></li>
    `;
  }
}

// Logout
async function logout() {
  try {
    sessionStorage.removeItem('token');
    await fetch(`${API_URL}/logout`, { method: 'POST' });
    window.location.href = '/index.html';
  } catch (error) {
    console.error('Error logging out:', error);
  }
}

// Login
async function login(email, password) {
  try {
    const response = await fetch(`${API_URL}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    const data = await response.json();
    if (data.success && data.token) {
      sessionStorage.setItem('token', data.token);
    }
    return data;
  } catch (error) {
    console.error('Error logging in:', error);
    return { success: false, message: 'Network error' };
  }
}

// Register
async function register(userData) {
  try {
    const response = await fetch(`${API_URL}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(userData)
    });

    const data = await response.json();
    if (data.success && data.token) {
      sessionStorage.setItem('token', data.token);
    }
    return data;
  } catch (error) {
    console.error('Error registering:', error);
    return { success: false, message: 'Network error' };
  }
}

// Verify Signup OTP
async function verifySignup(email, otp) {
  try {
    const response = await fetch(`${API_URL}/verify-signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, otp })
    });
    const data = await response.json();
    if (data.success && data.token) {
      sessionStorage.setItem('token', data.token);
    }
    return data;
  } catch (error) {
    console.error('Error verifying signup:', error);
    return { success: false, message: 'Network error' };
  }
}

// Forgot Password - Send OTP
async function forgotPassword(email) {
  try {
    const response = await fetch(`${API_URL}/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    return await response.json();
  } catch (error) {
    console.error('Error sending OTP:', error);
    return { success: false, message: 'Network error' };
  }
}

// Verify OTP
async function verifyOtp(email, otp) {
  try {
    const response = await fetch(`${API_URL}/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, otp })
    });
    return await response.json();
  } catch (error) {
    console.error('Error verifying OTP:', error);
    return { success: false, message: 'Network error' };
  }
}

// Reset Password
async function resetPassword(email, otp, newPassword) {
  try {
    const response = await fetch(`${API_URL}/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, otp, newPassword })
    });
    return await response.json();
  } catch (error) {
    console.error('Error resetting password:', error);
    return { success: false, message: 'Network error' };
  }
}

// Get Halls
async function getHalls(filters = {}) {
  try {
    const params = new URLSearchParams(filters);
    const response = await fetch(`${API_URL}/halls?${params}`);
    const data = await response.json();
    return data.success ? data.halls : [];
  } catch (error) {
    console.error('Error getting halls:', error);
    return [];
  }
}

// Get Hall by ID
async function getHall(id) {
  try {
    const response = await fetch(`${API_URL}/halls/${id}`);
    const data = await response.json();
    return data.success ? data.hall : null;
  } catch (error) {
    console.error('Error getting hall:', error);
    return null;
  }
}

// Get availability calendar for a hall
async function getHallAvailability(hallId, from, to) {
  try {
    const params = new URLSearchParams({ from, to });
    const response = await fetch(`${API_URL}/halls/${hallId}/availability?${params}`);
    const data = await response.json();
    return data.success ? data.availability : [];
  } catch (error) {
    console.error('Error getting hall availability:', error);
    return [];
  }
}

// Owner: block/unblock dates for a hall
async function updateHallBlockedDates(hallId, dates, action) {
  const token = sessionStorage.getItem('token');
  if (!token) return { success: false, message: 'Please login' };

  try {
    const response = await fetch(`${API_URL}/halls/${hallId}/block-dates`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ dates, action })
    });
    return await response.json();
  } catch (error) {
    console.error('Error updating blocked dates:', error);
    return { success: false, message: 'Network error' };
  }
}

// Create Booking (supports single date or date range)
async function createBooking(bookingData) {
  const token = sessionStorage.getItem('token');
  if (!token) return { success: false, message: 'Please login' };

  try {
    const response = await fetch(`${API_URL}/bookings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(bookingData)
    });

    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Error creating booking:', error);
    return { success: false, message: 'Network error' };
  }
}

// Check Availability (supports single date or date range)
async function checkAvailability(hallId, date, endDate = null) {
  try {
    let url = `${API_URL}/bookings/check/${hallId}/${date}`;
    if (endDate) {
      url += `?endDate=${endDate}`;
    }
    const response = await fetch(url);
    const data = await response.json();
    return data.available;
  } catch (error) {
    console.error('Error checking availability:', error);
    return false;
  }
}

// Get dynamic price quote for a hall (date or date range + optional addons)
async function getPriceQuote(hallId, payload) {
  try {
    const response = await fetch(`${API_URL}/halls/${hallId}/price-quote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    return data.success ? data.breakdown : null;
  } catch (error) {
    console.error('Error getting price quote:', error);
    return null;
  }
}

// Get recommended halls based on simple logic (budget, event type, etc.)
async function getRecommendedHalls(criteria = {}) {
  try {
    const response = await fetch(`${API_URL}/halls/recommend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(criteria)
    });
    const data = await response.json();
    return data.success ? data.halls : [];
  } catch (error) {
    console.error('Error getting recommended halls:', error);
    return [];
  }
}

// ========== Waitlist Functions ==========

// Join Waitlist
async function joinWaitlist(hallId, date) {
  const token = sessionStorage.getItem('token');
  if (!token) return { success: false, message: 'Please login' };

  try {
    const response = await fetch(`${API_URL}/waitlist/join`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ hallId, date })
    });
    return await response.json();
  } catch (error) {
    console.error('Error joining waitlist:', error);
    return { success: false, message: 'Network error' };
  }
}

// Get My Waitlist
async function getMyWaitlist() {
  const token = sessionStorage.getItem('token');
  if (!token) return [];

  try {
    const response = await fetch(`${API_URL}/waitlist/my`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await response.json();
    return data.success ? data.waitlist : [];
  } catch (error) {
    console.error('Error getting waitlist:', error);
    return [];
  }
}

// Leave Waitlist
async function leaveWaitlist(waitlistId) {
  const token = sessionStorage.getItem('token');
  if (!token) return { success: false, message: 'Please login' };

  try {
    const response = await fetch(`${API_URL}/waitlist/${waitlistId}/leave`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    return await response.json();
  } catch (error) {
    console.error('Error leaving waitlist:', error);
    return { success: false, message: 'Network error' };
  }
}

// Format Currency
function formatCurrency(amount) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR'
  }).format(amount);
}

// Format Date
function formatDate(dateString) {
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
}

// Show Alert
function showAlert(message, type = 'info') {
  const alertDiv = document.createElement('div');
  alertDiv.className = `alert alert-${type}`;
  alertDiv.style.cssText = `
    position: fixed;
    top: 80px;
    right: 20px;
    padding: 1rem 1.5rem;
    background: ${type === 'success' ? '#10b981' : type === 'error' ? '#ef4444' : '#6366f1'};
    color: white;
    border-radius: 8px;
    box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1);
    z-index: 3000;
    animation: slideInRight 0.3s;
  `;
  alertDiv.textContent = message;

  document.body.appendChild(alertDiv);

  setTimeout(() => {
    alertDiv.style.animation = 'slideOutRight 0.3s';
    setTimeout(() => alertDiv.remove(), 300);
  }, 3000);
}

// Show Modal
function showModal(content) {
  let modal = document.getElementById('modal');

  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'modal';
    modal.className = 'modal';
    document.body.appendChild(modal);
  }

  modal.innerHTML = `
    <div class="modal-content">
      <div class="modal-header">
        <h2>Information</h2>
        <button class="modal-close" onclick="closeModal()">&times;</button>
      </div>
      <div class="modal-body">
        ${content}
      </div>
    </div>
  `;

  modal.classList.add('active');
}

function closeModal() {
  const modal = document.getElementById('modal');
  if (modal) {
    modal.classList.remove('active');
  }
}

// Toggle Mobile Menu
function toggleMobileMenu() {
  const navLinks = document.querySelector('.navbar-nav');
  navLinks.classList.toggle('active');
}

// Get User Location
function getUserLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Geolocation not supported'));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      position => {
        resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude
        });
      },
      error => {
        reject(error);
      }
    );
  });
}

// Add CSS animations
const style = document.createElement('style');
style.textContent = `
  @keyframes slideInRight {
    from {
      transform: translateX(100%);
      opacity: 0;
    }
    to {
      transform: translateX(0);
      opacity: 1;
    }
  }
  
  @keyframes slideOutRight {
    from {
      transform: translateX(0);
      opacity: 1;
    }
    to {
      transform: translateX(100%);
      opacity: 0;
    }
  }
`;
document.head.appendChild(style);

// Auto-Refresh Logic
setInterval(async () => {
  // Silent refresh for data visualization (just re-running current user check for now to keep header sync)
  // In a real app, this could also refetch lists if we are on those pages
  const navLinks = document.querySelector('.navbar-nav');
  if (navLinks) {
    // Only update if something changed to avoid flicker? 
    // For now, simpler to just run updateNavbar which fetches user
    // updateNavbar(); // This might cause flicker if dom is rebuilt.

    // Better: Check session validity silently
    const user = await getCurrentUser();
    if (!user && sessionStorage.getItem('token')) {
      // Token invalid/expired
      sessionStorage.removeItem('token');
      window.location.href = '/login.html';
    }
  }
}, 2000);

// Initialize navbar on page load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', updateNavbar);
} else {
  updateNavbar();
}

// ========== Comparison Feature ==========

// Get comparison list from localStorage
function getComparisonList() {
  const stored = localStorage.getItem('hallComparison');
  return stored ? JSON.parse(stored) : [];
}

// Save comparison list to localStorage
function saveComparisonList(hallIds) {
  localStorage.setItem('hallComparison', JSON.stringify(hallIds));
}

// Add hall to comparison (max 4)
function addToComparison(hallId) {
  const list = getComparisonList();
  if (list.includes(hallId)) {
    return false; // Already in comparison
  }
  if (list.length >= 4) {
    showAlert('You can compare up to 4 halls at a time', 'warning');
    return false;
  }
  list.push(hallId);
  saveComparisonList(list);
  updateComparisonBar();
  updateCompareButtons();
  showAlert('Hall added to comparison', 'success');
  return true;
}

// Remove hall from comparison
function removeFromComparison(hallId) {
  const list = getComparisonList();
  const index = list.indexOf(hallId);
  if (index > -1) {
    list.splice(index, 1);
    saveComparisonList(list);
    updateComparisonBar();
    updateCompareButtons();
    showAlert('Hall removed from comparison', 'info');
    return true;
  }
  return false;
}

// Toggle hall in comparison
function toggleCompare(hallId) {
  const list = getComparisonList();
  if (list.includes(hallId)) {
    removeFromComparison(hallId);
  } else {
    addToComparison(hallId);
  }
}

// Clear all comparisons
function clearComparison() {
  localStorage.removeItem('hallComparison');
  updateComparisonBar();
  updateCompareButtons();
  showAlert('Comparison cleared', 'info');
}

// Update comparison bar UI
async function updateComparisonBar() {
  const bar = document.getElementById('comparisonBar');
  const hallsList = document.getElementById('comparisonHalls');
  const viewBtn = document.querySelector('.comparison-view-btn');
  const countSpan = document.querySelector('.comparison-count');
  
  if (!bar) return;

  const list = getComparisonList();
  
  if (list.length === 0) {
    bar.style.display = 'none';
    return;
  }

  bar.style.display = 'block';
  countSpan.textContent = `${list.length} hall${list.length > 1 ? 's' : ''} selected`;
  
  if (viewBtn) {
    viewBtn.disabled = list.length < 2;
    viewBtn.textContent = `Compare (${list.length})`;
  }

  // Fetch hall details for display
  const halls = await Promise.all(list.map(id => getHall(id)));
  const validHalls = halls.filter(h => h !== null);

  if (hallsList) {
    hallsList.innerHTML = validHalls.map(hall => `
      <div class="comparison-hall-item" data-hall-id="${hall._id}">
        <img src="${hall.images[0]}" alt="${hall.name}" class="comparison-hall-img">
        <div class="comparison-hall-info">
          <div class="comparison-hall-name">${hall.name}</div>
          <div class="comparison-hall-price">${formatCurrency(hall.price)}</div>
        </div>
        <button onclick="removeFromComparison('${hall._id}')" class="comparison-remove-btn" title="Remove">×</button>
      </div>
    `).join('');
  }
}

// Update compare buttons state
function updateCompareButtons() {
  const list = getComparisonList();
  document.querySelectorAll('.compare-btn').forEach(btn => {
    const hallId = btn.getAttribute('data-hall-id');
    if (list.includes(hallId)) {
      btn.classList.add('active');
      btn.style.background = 'linear-gradient(135deg, var(--primary) 0%, var(--primary-light) 100%)';
      btn.style.color = 'white';
    } else {
      btn.classList.remove('active');
      btn.style.background = '';
      btn.style.color = '';
    }
  });
}

// Open comparison page/modal
async function openComparison() {
  const list = getComparisonList();
  if (list.length < 2) {
    showAlert('Please select at least 2 halls to compare', 'warning');
    return;
  }

  // Fetch all hall details
  const halls = await Promise.all(list.map(id => getHall(id)));
  const validHalls = halls.filter(h => h !== null);

  if (validHalls.length < 2) {
    showAlert('Some halls could not be loaded', 'error');
    return;
  }

  // Get selected date from filter if available
  const selectedDate = document.getElementById('dateFilter')?.value || '';

  // Show comparison modal
  showComparisonModal(validHalls, selectedDate);
}

// Show comparison modal/overlay
function showComparisonModal(halls, selectedDate) {
  // Create modal content
  const modalContent = `
    <div class="comparison-modal">
      <div class="comparison-modal-header">
        <h2>Compare Halls</h2>
        <button onclick="closeComparisonModal()" class="comparison-close-btn">×</button>
      </div>
      <div class="comparison-modal-body">
        ${selectedDate ? `
          <div class="comparison-date-selector">
            <label>Check availability for:</label>
            <input type="date" id="comparisonDate" value="${selectedDate}" onchange="updateComparisonAvailability()">
          </div>
        ` : `
          <div class="comparison-date-selector">
            <label>Check availability for:</label>
            <input type="date" id="comparisonDate" onchange="updateComparisonAvailability()">
          </div>
        `}
        <div id="comparisonTableContainer" class="comparison-table-container">
          ${generateComparisonTable(halls, selectedDate)}
        </div>
      </div>
    </div>
  `;

  // Create or update modal
  let modal = document.getElementById('comparisonModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'comparisonModal';
    modal.className = 'comparison-modal-overlay';
    document.body.appendChild(modal);
  }
  
  modal.innerHTML = modalContent;
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';

  // Load availability if date is provided
  if (selectedDate) {
    updateComparisonAvailability();
  }
}

// Generate comparison table HTML
function generateComparisonTable(halls, selectedDate) {
  // Get all unique amenities across all halls
  const allAmenities = new Set();
  halls.forEach(hall => {
    if (Array.isArray(hall.amenities)) {
      hall.amenities.forEach(am => allAmenities.add(am));
    }
  });
  const amenitiesList = Array.from(allAmenities);

  let html = `
    <div class="comparison-table-wrapper">
      <table class="comparison-table">
        <thead>
          <tr>
            <th class="comparison-row-header">Feature</th>
            ${halls.map(hall => `
              <th class="comparison-hall-header">
                <img src="${hall.images[0]}" alt="${hall.name}" class="comparison-table-img">
                <div class="comparison-table-hall-name">${hall.name}</div>
                <a href="/hall.html?id=${hall._id}" class="btn btn-sm btn-primary" style="margin-top: 0.5rem;">View Details</a>
              </th>
            `).join('')}
          </tr>
        </thead>
        <tbody>
          <!-- Price -->
          <tr>
            <td class="comparison-row-header"><strong>Price</strong></td>
            ${halls.map(hall => `
              <td class="comparison-cell">
                <div class="comparison-price">${formatCurrency(hall.price)}</div>
                <div class="comparison-price-label">per event</div>
              </td>
            `).join('')}
          </tr>
          
          <!-- Capacity -->
          <tr>
            <td class="comparison-row-header"><strong>Capacity</strong></td>
            ${halls.map(hall => `
              <td class="comparison-cell">
                <div class="comparison-capacity">${hall.capacity || 'N/A'}</div>
                <div class="comparison-capacity-label">guests</div>
              </td>
            `).join('')}
          </tr>
          
          <!-- Location -->
          <tr>
            <td class="comparison-row-header"><strong>Location</strong></td>
            ${halls.map(hall => `
              <td class="comparison-cell">
                <div class="comparison-location">📍 ${hall.location || 'N/A'}</div>
              </td>
            `).join('')}
          </tr>
          
          <!-- Rating -->
          <tr>
            <td class="comparison-row-header"><strong>Rating</strong></td>
            ${halls.map(hall => `
              <td class="comparison-cell">
                <div class="comparison-rating">
                  ⭐ ${hall.rating || 0} 
                  <span class="comparison-reviews">(${hall.reviews || 0} reviews)</span>
                </div>
              </td>
            `).join('')}
          </tr>
          
          <!-- Availability -->
          <tr>
            <td class="comparison-row-header"><strong>Availability</strong></td>
            ${halls.map((hall, index) => `
              <td class="comparison-cell" id="availability-${hall._id}">
                <div class="comparison-availability-loading">Loading...</div>
              </td>
            `).join('')}
          </tr>
          
          <!-- Amenities -->
          ${amenitiesList.length > 0 ? amenitiesList.map(amenity => `
            <tr>
              <td class="comparison-row-header">${amenity}</td>
              ${halls.map(hall => `
                <td class="comparison-cell">
                  ${Array.isArray(hall.amenities) && hall.amenities.includes(amenity) 
                    ? '<span class="comparison-check">✓</span>' 
                    : '<span class="comparison-cross">✗</span>'}
                </td>
              `).join('')}
            </tr>
          `).join('') : ''}
        </tbody>
      </table>
    </div>
  `;

  return html;
}

// Check availability for multiple halls (batch)
async function checkMultipleAvailability(hallIds, date) {
  try {
    const response = await fetch(`${API_URL}/bookings/check-multiple`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hallIds, date })
    });
    const data = await response.json();
    return data.success ? data.results : [];
  } catch (error) {
    console.error('Error checking multiple availability:', error);
    return [];
  }
}

// Update availability in comparison table
async function updateComparisonAvailability() {
  const dateInput = document.getElementById('comparisonDate');
  if (!dateInput || !dateInput.value) {
    // Clear availability if no date
    document.querySelectorAll('[id^="availability-"]').forEach(cell => {
      cell.innerHTML = '<div class="comparison-availability-na">Select a date</div>';
    });
    return;
  }

  const selectedDate = dateInput.value;
  const list = getComparisonList();
  
  // Show loading state for all
  list.forEach(hallId => {
    const cell = document.getElementById(`availability-${hallId}`);
    if (cell) {
      cell.innerHTML = '<div class="comparison-availability-loading">Checking...</div>';
    }
  });

  try {
    // Use batch endpoint for better performance
    const availabilityResults = await checkMultipleAvailability(list, selectedDate);
    
    // Update each cell with results
    for (const result of availabilityResults) {
      const cell = document.getElementById(`availability-${result.hallId}`);
      if (!cell) continue;

      if (result.error) {
        cell.innerHTML = '<div class="comparison-availability-error">Error</div>';
        continue;
      }

      if (result.available) {
        // Get price quote for the date
        const hall = await getHall(result.hallId);
        const quote = await getPriceQuote(result.hallId, { date: selectedDate });
        const finalPrice = quote ? formatCurrency(quote.total) : formatCurrency(hall.price);
        
        cell.innerHTML = `
          <div class="comparison-availability-available">
            <span class="availability-badge available">Available</span>
            <div class="comparison-date-price">${finalPrice}</div>
          </div>
        `;
      } else {
        const reason = result.isBooked ? 'Booked' : result.isBlocked ? 'Blocked' : 'Not Available';
        cell.innerHTML = `
          <div class="comparison-availability-unavailable">
            <span class="availability-badge unavailable">${reason}</span>
          </div>
        `;
      }
    }
  } catch (error) {
    console.error('Error updating comparison availability:', error);
    list.forEach(hallId => {
      const cell = document.getElementById(`availability-${hallId}`);
      if (cell) {
        cell.innerHTML = '<div class="comparison-availability-error">Error</div>';
      }
    });
  }
}

// Close comparison modal
function closeComparisonModal() {
  const modal = document.getElementById('comparisonModal');
  if (modal) {
    modal.style.display = 'none';
    document.body.style.overflow = '';
  }
}

// Close modal on outside click
document.addEventListener('click', (e) => {
  const modal = document.getElementById('comparisonModal');
  if (modal && e.target === modal) {
    closeComparisonModal();
  }
});
