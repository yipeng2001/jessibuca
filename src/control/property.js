export default (player, control) => {

    Object.defineProperty(control, 'controlsRect', {
        get: () => {
            return control.$controls.getBoundingClientRect();
        },
    });

    // Danmaku properties and methods
    if (player._opt.danmaku) {
        control.danmakuList = [];
        control.danmakuEnabled = true;
        control.danmakuId = 0;

        // Send danmaku message
        control.sendDanmaku = function(text, color) {
            if (!text || !control.danmakuEnabled) return;
            
            const danmaku = {
                id: ++control.danmakuId,
                text: text,
                color: color || player._opt.danmakuConfig.defaultColor,
                timestamp: Date.now(),
                element: null
            };

            control.showDanmaku(danmaku);
            player.emit('danmakuSend', danmaku);
        };

        // Show danmaku on screen
        control.showDanmaku = function(danmaku) {
            if (!control.$danmakuDisplay || control.danmakuList.length >= player._opt.danmakuConfig.maxDisplay) {
                return;
            }

            const element = document.createElement('div');
            element.className = 'jessibuca-danmaku-item';
            element.textContent = danmaku.text;
            element.style.color = danmaku.color;
            element.style.fontSize = player._opt.danmakuConfig.fontSize + 'px';
            element.style.opacity = player._opt.danmakuConfig.opacity;
            
            // Random vertical position
            const maxTop = control.$danmakuDisplay.clientHeight - 30;
            const top = Math.floor(Math.random() * Math.max(maxTop, 0));
            element.style.top = top + 'px';
            
            // Animation
            element.style.animationDuration = player._opt.danmakuConfig.speed + 's';
            
            danmaku.element = element;
            control.danmakuList.push(danmaku);
            control.$danmakuDisplay.appendChild(element);

            // Remove after animation
            setTimeout(() => {
                control.removeDanmaku(danmaku.id);
            }, player._opt.danmakuConfig.speed * 1000);

            player.emit('danmakuShow', danmaku);
        };

        // Remove danmaku
        control.removeDanmaku = function(id) {
            const index = control.danmakuList.findIndex(d => d.id === id);
            if (index !== -1) {
                const danmaku = control.danmakuList[index];
                if (danmaku.element && danmaku.element.parentNode) {
                    danmaku.element.parentNode.removeChild(danmaku.element);
                }
                control.danmakuList.splice(index, 1);
            }
        };

        // Clear all danmaku
        control.clearDanmaku = function() {
            control.danmakuList.forEach(danmaku => {
                if (danmaku.element && danmaku.element.parentNode) {
                    danmaku.element.parentNode.removeChild(danmaku.element);
                }
            });
            control.danmakuList = [];
            player.emit('danmakuClear');
        };

        // Toggle danmaku display
        control.toggleDanmaku = function() {
            control.danmakuEnabled = !control.danmakuEnabled;
            if (control.$danmakuContainer) {
                control.$danmakuContainer.style.display = control.danmakuEnabled ? 'block' : 'none';
            }
            if (!control.danmakuEnabled) {
                control.clearDanmaku();
            }
        };
    }

}
