
              const EMOJIS = ['', '', '', '', '', '', '', '', '', '', '', '', '', '', ''];
              let selectedEmoji = '';
              document.addEventListener('DOMContentLoaded', () => {
                const c = document.getElementById('emojiOpts');
                c.innerHTML = EMOJIS.map(e => `<button class="emoji-opt${e === '' ? ' selected' : ''}" onclick="selectEmoji('${e}',this)">${e}</button>`).join('');
              });
              function selectEmoji(e, el) {
                selectedEmoji = e;
                document.querySelectorAll('.emoji-opt').forEach(b => b.classList.remove('selected'));
                el.classList.add('selected');
              }
            