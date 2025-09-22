class BotPanel {
    constructor() {
        this.initializeEventListeners();
        this.startStatusChecker();
        this.addLog('Panel initialized');
    }

    initializeEventListeners() {
        // Start button
        document.getElementById('startBtn').addEventListener('click', () => {
            this.startBot();
        });

        // Stop button
        document.getElementById('stopBtn').addEventListener('click', () => {
            this.stopBot();
        });

        // Clear button
        document.getElementById('clearBtn').addEventListener('click', () => {
            this.clearConfig();
        });

        // Clear logs button
        document.getElementById('clearLogs').addEventListener('click', () => {
            this.clearLogs();
        });

        // File input change
        document.getElementById('appStateFile').addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                this.addLog(`File selected: ${e.target.files[0].name}`);
            }
        });
    }

    async startBot() {
        const appStateFile = document.getElementById('appStateFile').files[0];
        const ownerUID = document.getElementById('ownerUID').value.trim();

        if (!appStateFile) {
            this.showNotification('Please select an appstate file', 'error');
            return;
        }

        if (!ownerUID || !/^\d+$/.test(ownerUID)) {
            this.showNotification('Please enter a valid Admin UID (numbers only)', 'error');
            return;
        }

        const formData = new FormData();
        formData.append('appstate', appStateFile);
        formData.append('ownerUID', ownerUID);

        try {
            this.showNotification('Starting bot...', 'warning');
            this.addLog('Attempting to start bot...');

            const response = await fetch('/api/start', {
                method: 'POST',
                body: formData
            });

            const result = await response.json();

            if (result.success) {
                this.showNotification(result.message, 'success');
                this.addLog('Bot started successfully');
                this.updateUI();
            } else {
                this.showNotification(result.message, 'error');
                this.addLog(`Start failed: ${result.message}`);
            }
        } catch (error) {
            this.showNotification('Network error: ' + error.message, 'error');
            this.addLog(`Network error: ${error.message}`);
        }
    }

    async stopBot() {
        try {
            this.showNotification('Stopping bot...', 'warning');
            this.addLog('Attempting to stop bot...');

            const response = await fetch('/api/stop', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            const result = await response.json();

            if (result.success) {
                this.showNotification(result.message, 'success');
                this.addLog('Bot stopped successfully');
                this.updateUI();
            } else {
                this.showNotification(result.message, 'error');
                this.addLog(`Stop failed: ${result.message}`);
            }
        } catch (error) {
            this.showNotification('Network error: ' + error.message, 'error');
            this.addLog(`Network error: ${error.message}`);
        }
    }

    async clearConfig() {
        if (!confirm('Are you sure you want to clear all configuration? This cannot be undone.')) {
            return;
        }

        try {
            const response = await fetch('/api/clear', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            const result = await response.json();

            if (result.success) {
                this.showNotification(result.message, 'success');
                this.addLog('Configuration cleared');
                this.updateUI();
                
                // Clear form
                document.getElementById('appStateFile').value = '';
                document.getElementById('ownerUID').value = '';
            } else {
                this.showNotification(result.message, 'error');
                this.addLog(`Clear failed: ${result.message}`);
            }
        } catch (error) {
            this.showNotification('Network error: ' + error.message, 'error');
            this.addLog(`Network error: ${error.message}`);
        }
    }

    async updateUI() {
        try {
            const response = await fetch('/api/status');
            const status = await response.json();

            // Update status indicator
            const statusDot = document.querySelector('.status-dot');
            const statusText = document.querySelector('.status-text');
            const botStatus = document.getElementById('botStatus');
            const adminUID = document.getElementById('adminUID');
            const lastStarted = document.getElementById('lastStarted');
            const memoryUsage = document.getElementById('memoryUsage');
            const uptime = document.getElementById('uptime');

            if (status.running) {
                statusDot.className = 'status-dot online';
                statusText.textContent = 'Online';
                botStatus.textContent = 'Running';
                botStatus.style.color = '#4CAF50';
                
                document.getElementById('startBtn').disabled = true;
                document.getElementById('stopBtn').disabled = false;
            } else {
                statusDot.className = 'status-dot offline';
                statusText.textContent = 'Offline';
                botStatus.textContent = 'Stopped';
                botStatus.style.color = '#f44336';
                
                document.getElementById('startBtn').disabled = false;
                document.getElementById('stopBtn').disabled = true;
            }

            // Update config info
            if (status.config) {
                adminUID.textContent = status.config.ownerUID || 'Not set';
                
                if (status.config.lastStarted) {
                    const date = new Date(status.config.lastStarted);
                    lastStarted.textContent = date.toLocaleString();
                } else {
                    lastStarted.textContent = 'Never';
                }
            } else {
                adminUID.textContent = 'Not set';
                lastStarted.textContent = 'Never';
            }

            // Update memory info
            if (status.memory) {
                memoryUsage.textContent = status.memory.usage ? 
                    Math.round(status.memory.usage) + ' MB' : '0 MB';
                
                if (status.memory.uptime) {
                    const hours = Math.floor(status.memory.uptime / 3600);
                    const minutes = Math.floor((status.memory.uptime % 3600) / 60);
                    const seconds = Math.floor(status.memory.uptime % 60);
                    uptime.textContent = `${hours}h ${minutes}m ${seconds}s`;
                } else {
                    uptime.textContent = '0s';
                }
            }
        } catch (error) {
            console.error('Status update error:', error);
        }
    }

    startStatusChecker() {
        // Update immediately
        this.updateUI();
        
        // Update every 5 seconds
        setInterval(() => {
            this.updateUI();
        }, 5000);
    }

    addLog(message) {
        const logs = document.getElementById('logs');
        const logEntry = document.createElement('div');
        logEntry.className = 'log-entry';
        
        const timestamp = new Date().toLocaleTimeString();
        logEntry.textContent = `[${timestamp}] ${message}`;
        
        logs.appendChild(logEntry);
        logs.scrollTop = logs.scrollHeight;
    }

    clearLogs() {
        const logs = document.getElementById('logs');
        logs.innerHTML = '<div class="log-entry">Logs cleared</div>';
    }

    showNotification(message, type = 'info') {
        const notification = document.getElementById('notification');
        const notificationText = document.getElementById('notificationText');
        
        notificationText.textContent = message;
        notification.className = `notification ${type}`;
        notification.classList.remove('hidden');
        
        // Auto-hide after 5 seconds
        setTimeout(() => {
            this.hideNotification();
        }, 5000);
    }
}

function hideNotification() {
    const notification = document.getElementById('notification');
    notification.classList.add('hidden');
}

// Initialize the panel when page loads
document.addEventListener('DOMContentLoaded', () => {
    new BotPanel();
});
