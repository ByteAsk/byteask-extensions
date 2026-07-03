;;; byteask.el --- Drive the ByteAsk C/C++ agentic coding harness  -*- lexical-binding: t; -*-

;; Author: ByteAsk <anirudha@byteask.ai>
;; Maintainer: ByteAsk <anirudha@byteask.ai>
;; URL: https://github.com/ByteAsk/byteask-extensions
;; Version: 0.1.0
;; Package-Requires: ((emacs "28.1"))
;; Keywords: tools, convenience, c, languages

;; This file is not part of GNU Emacs.

;; Licensed under the Apache License, Version 2.0 (the "License"); you may
;; not use this file except in compliance with the License. You may obtain
;; a copy of the License at http://www.apache.org/licenses/LICENSE-2.0

;;; Commentary:

;; Drives the `byteask' CLI (https://byteask.ai) from Emacs -- an
;; interactive terminal session, headless exec/review/apply commands
;; streamed into a dedicated buffer, and diagnostics-aware fixes via
;; Flymake.  Follows the same connector contract as byteask.nvim and
;; vscode-byteask: same command set, same `command'/`model'/`extra-args'/
;; `auto-apply' settings.
;;
;; Join the community: https://discord.gg/vx5Eu4YNzG -- support, direct
;; access to the team, and the fastest way to report an issue.  Direct
;; email: anirudha@byteask.ai.
;;
;; Quick start:
;;   (use-package byteask :vc (:url "https://github.com/ByteAsk/byteask-extensions"
;;                                  :lisp-dir "emacs"))
;;   M-x byteask                  ; interactive session
;;   M-x byteask-exec              ; one-shot headless prompt
;;   M-x byteask-exec-region       ; send the active region as context
;;   M-x byteask-fix-diagnostics   ; fix Flymake diagnostics in this buffer
;;   M-x byteask-review            ; review the repository
;;   M-x byteask-apply             ; apply the agent's latest diff
;;   M-x byteask-resume            ; resume a previous session

;;; Code:

(require 'subr-x)
(require 'ansi-color)
(require 'term)
(require 'flymake)

;; `eat' and `vterm' are optional, soft dependencies (see
;; `byteask-terminal-backend') -- neither is required'd unconditionally, so
;; the byte-compiler has no way to know `vterm-shell' is a dynamically-scoped
;; special variable defined in the `vterm' package. Declaring it here (the
;; standard idiom for "this is dynamic, defined elsewhere, trust me") is
;; what makes the `let'-binding in `byteask' actually override it at
;; runtime, rather than silently compiling to a no-op lexical shadow.
(defvar vterm-shell)

(defgroup byteask nil
  "Drive the ByteAsk C/C++ agentic coding harness."
  :group 'tools
  :prefix "byteask-")

(defcustom byteask-command "byteask"
  "Path to the `byteask' executable, or just \"byteask\" if it is on PATH."
  :type 'string
  :group 'byteask)

(defcustom byteask-model ""
  "Model passed via `-m'.  Empty string means byteask's own default."
  :type 'string
  :group 'byteask)

(defcustom byteask-extra-args nil
  "Extra CLI arguments appended to every invocation, e.g. (\"-c\" \"key=value\")."
  :type '(repeat string)
  :group 'byteask)

(defcustom byteask-auto-apply nil
  "When non-nil, run `byteask apply' automatically after a successful exec."
  :type 'boolean
  :group 'byteask)

(defcustom byteask-terminal-backend 'auto
  "Which terminal package to use for the interactive session (`M-x byteask').

`auto' picks the best available backend in this order: `eat' (pure
Elisp, no native module to compile), `vterm' (libvterm, needs a
compiled module but already present for many users), then Emacs's
built-in `ansi-term' as a last resort that always works with no
dependency at all."
  :type '(choice (const :tag "Automatic" auto)
                 (const :tag "eat" eat)
                 (const :tag "vterm" vterm)
                 (const :tag "ansi-term (built-in)" ansi-term))
  :group 'byteask)

(defconst byteask--buffer-name "*byteask*"
  "Name of the buffer headless commands stream their output into.")

(defvar byteask--process nil
  "The currently running headless byteask process, or nil.")

;;; ---------------------------------------------------------------------
;;; Shared plumbing

(defun byteask--common-flags ()
  "Return the -m/model and extra-args flags shared by every invocation."
  (append
   (when (and byteask-model (not (string-empty-p byteask-model)))
     (list "-m" byteask-model))
   byteask-extra-args))

(defun byteask--project-root ()
  "Best-effort project root: `project.el' if available, else `default-directory'."
  (or (when (fboundp 'project-current)
        (when-let* ((proj (project-current)))
          (if (fboundp 'project-root)
              (project-root proj)
            (car (with-no-warnings (project-roots proj))))))
      default-directory))

(defun byteask--output-buffer ()
  "Get-or-create the shared output buffer, with ANSI colors enabled."
  (let ((buf (get-buffer-create byteask--buffer-name)))
    (with-current-buffer buf
      (unless (derived-mode-p 'byteask-output-mode)
        (byteask-output-mode)))
    buf))

(define-derived-mode byteask-output-mode special-mode "ByteAsk"
  "Major mode for the ByteAsk headless-command output buffer."
  (setq buffer-read-only t))

;;; ---------------------------------------------------------------------
;;; Tier 1: interactive terminal session

;;;###autoload
(defun byteask (&optional args)
  "Open an interactive ByteAsk session in a terminal.

With a prefix ARGS (a list of extra CLI args), pass them through
after the common flags -- used internally by `byteask-resume' /
`byteask-resume-last'."
  (interactive)
  (let* ((default-directory (byteask--project-root))
         (argv (append (list byteask-command) (byteask--common-flags) args))
         (command-line (mapconcat #'shell-quote-argument argv " "))
         (backend (byteask--resolve-terminal-backend)))
    (pcase backend
      ('eat
       (let ((eat-buffer (funcall (intern "eat-make") "byteask" shell-file-name nil "-c" command-line)))
         (pop-to-buffer (if (bufferp eat-buffer) eat-buffer (current-buffer)))))
      ('vterm
       (let ((vterm-shell command-line))
         (funcall (intern "vterm") "*byteask-terminal*")))
      (_
       (ansi-term shell-file-name "byteask-terminal")
       (term-send-raw-string (concat command-line "\n"))))))

(defun byteask--resolve-terminal-backend ()
  "Resolve `byteask-terminal-backend' `auto' to a concrete, available backend."
  (if (not (eq byteask-terminal-backend 'auto))
      byteask-terminal-backend
    (cond
     ((require 'eat nil t) 'eat)
     ((require 'vterm nil t) 'vterm)
     (t 'ansi-term))))

;;;###autoload
(defun byteask-resume ()
  "Resume a previous ByteAsk session (interactive picker)."
  (interactive)
  (byteask '("resume")))

;;;###autoload
(defun byteask-resume-last ()
  "Resume the most recent ByteAsk session."
  (interactive)
  (byteask '("resume" "--last")))

;;; ---------------------------------------------------------------------
;;; Tier 2: headless commands, async, streamed into `byteask--buffer-name'

(defun byteask--run-headless (subcommand-args label &optional with-common apply-after)
  "Run `byteask SUBCOMMAND-ARGS' asynchronously, streaming into the output buffer.

LABEL is a short string used in messages.  WITH-COMMON includes the
model/extra-args flags (nil for `apply', which rejects them).
APPLY-AFTER runs `byteask-apply' again once this finishes with exit
code 0."
  (when (and byteask--process (process-live-p byteask--process))
    (user-error "ByteAsk: a headless run is already in progress"))
  (let* ((default-directory (byteask--project-root))
         (head (car subcommand-args))
         (rest (cdr subcommand-args))
         (argv (append (list head)
                       (if with-common (byteask--common-flags) nil)
                       rest))
         (buf (byteask--output-buffer)))
    (with-current-buffer buf
      (let ((inhibit-read-only t))
        (goto-char (point-max))
        (insert (format "\n$ %s %s\n\n" byteask-command (mapconcat #'identity argv " ")))))
    (display-buffer buf)
    (setq byteask--process
          (make-process
           :name "byteask"
           :buffer buf
           :command (append (list byteask-command) argv)
           :filter #'byteask--process-filter
           :sentinel (lambda (proc event)
                       (byteask--process-sentinel proc event label apply-after))))))

(defun byteask--process-filter (proc string)
  "Append STRING (ANSI-colorized) from PROC into its buffer."
  (when (buffer-live-p (process-buffer proc))
    (with-current-buffer (process-buffer proc)
      (let ((inhibit-read-only t)
            (moving (= (point) (process-mark proc))))
        (save-excursion
          (goto-char (process-mark proc))
          (insert (ansi-color-apply string))
          (set-marker (process-mark proc) (point)))
        (if moving (goto-char (process-mark proc)))))))

(defun byteask--process-sentinel (_proc event label apply-after)
  "Handle EVENT for the finished headless byteask process (LABEL, APPLY-AFTER)."
  (setq byteask--process nil)
  (cond
   ((string-prefix-p "finished" event)
    (if apply-after
        (byteask-apply)
      (message "ByteAsk %s finished." label)))
   (t
    (message "ByteAsk %s exited: %s" label (string-trim event)))))

;;;###autoload
(defun byteask-apply ()
  "Run `byteask apply' -- no `-m'/`-c' flags, it rejects them."
  (interactive)
  (byteask--run-headless '("apply") "apply" nil))

;;;###autoload
(defun byteask-review ()
  "Run `byteask review' on the whole repository."
  (interactive)
  (byteask--run-headless '("review") "review" t))

;;;###autoload
(defun byteask-exec (instruction)
  "Run `byteask exec INSTRUCTION' headless."
  (interactive
   (list (read-string "ByteAsk exec -- what should the agent do? ")))
  (when (string-empty-p (string-trim instruction))
    (user-error "ByteAsk: no instruction given"))
  (byteask--run-headless (list "exec" instruction) "exec" t byteask-auto-apply))

;;;###autoload
(defun byteask-exec-region (start end instruction)
  "Run `byteask exec' with the region START..END appended as context.

Prompts for INSTRUCTION when called interactively."
  (interactive
   (progn
     (unless (use-region-p)
       (user-error "ByteAsk: no active region"))
     (list (region-beginning) (region-end)
           (read-string "ByteAsk exec on selection -- instruction: " "Improve this code."))))
  (let* ((selection (buffer-substring-no-properties start end))
         (rel (if buffer-file-name
                  (file-relative-name buffer-file-name (byteask--project-root))
                "(unsaved buffer)"))
         (prompt (format "%s (from %s)\n\n```\n%s\n```" instruction rel selection)))
    (byteask--run-headless (list "exec" prompt) "exec" t byteask-auto-apply)))

(defun byteask--flymake-severity-label (type)
  "Map a Flymake diagnostic TYPE symbol to the same labels other connectors use."
  (cond
   ((eq type :error) "ERROR")
   ((eq type :warning) "WARN")
   (t "INFO")))

;;;###autoload
(defun byteask-fix-diagnostics ()
  "Format this buffer's Flymake diagnostics into a prompt for `byteask exec'."
  (interactive)
  (unless (bound-and-true-p flymake-mode)
    (user-error "ByteAsk: Flymake is not active in this buffer"))
  (let ((diags (flymake-diagnostics)))
    (unless diags
      (user-error "ByteAsk: no diagnostics in this buffer"))
    (let* ((rel (if buffer-file-name
                    (file-relative-name buffer-file-name (byteask--project-root))
                  (buffer-name)))
           (block (mapconcat
                   (lambda (d)
                     (let* ((beg (flymake-diagnostic-beg d))
                            (line (line-number-at-pos beg))
                            (col (save-excursion (goto-char beg) (1+ (current-column))))
                            (severity (byteask--flymake-severity-label (flymake-diagnostic-type d)))
                            (msg (replace-regexp-in-string "\n" " " (flymake-diagnostic-text d))))
                       (format "%s:%d:%d: %s: %s" rel line col severity msg)))
                   diags "\n"))
           (prompt (format "Fix the following compiler/linter diagnostics in %s. Make the minimal correct change and keep the build green:\n\n```\n%s\n```" rel block)))
      (byteask--run-headless (list "exec" prompt) "exec" t byteask-auto-apply))))

(provide 'byteask)

;;; byteask.el ends here
