#!/usr/bin/env bash
set -e

SESSION="souljam"
PROJECT_DIR="/Users/pshelley/sprite-tools/sprite-factory"

# Rename existing session if it exists
if tmux has-session -t "$SESSION" 2>/dev/null; then
  TIMESTAMP=$(date +%Y%m%d-%H%M%S)
  tmux rename-session -t "$SESSION" "${SESSION}-${TIMESTAMP}"
fi

tmux new-session -d -s "$SESSION" -n Head -c "$PROJECT_DIR"
tmux send-keys -t "$SESSION:Head" 'claude' C-m

tmux new-window -t "$SESSION" -n upload -c "$PROJECT_DIR"
tmux send-keys -t "$SESSION:upload" 'claude' C-m

tmux new-window -t "$SESSION" -n clothes -c "$PROJECT_DIR"
tmux send-keys -t "$SESSION:clothes" 'claude' C-m

tmux new-window -t "$SESSION" -n animation -c "$PROJECT_DIR"
tmux send-keys -t "$SESSION:animation" 'claude' C-m

tmux new-window -t "$SESSION" -n review -c "$PROJECT_DIR"
tmux send-keys -t "$SESSION:review" 'claude' C-m

tmux attach -t "$SESSION"
