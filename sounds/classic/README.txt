"CLASSIC GAME SHOW" SOUND SET (optional, off by default)
=======================================================

This folder is an alternative set of sounds. Nothing here is included in the app and it is NOT the default: the tech chooses
"Classic game show (your own files)" in the Sound box of the projector panel, and only then does the projector laptop use it.
Any sound you do not provide falls back to the app's built-in sound.

Put your files here, named like this (mp3, ogg, wav or m4a):

  intro.mp3      the opening theme as the game begins
  ding.mp3       the correct-answer "ding" when an answer is revealed
  buzzer.mp3     the wrong-answer / strike buzzer
  fanfare.mp3    the round-won music
  applause.mp3   crowd applause
  fastmoney.mp3  the Fast Money music
  thinking.mp3   background music (loops until stopped)
  drumroll.mp3   a drum roll
  tick.mp3       one tick of a countdown (played in each of the last 5 seconds)
  timeup.mp3     time is up
  steal.mp3      the steal alert after three strikes
  sting.mp3      a new round or survey question starts

COPYRIGHT: the sounds of the television show are copyrighted, so this repository does not contain them and git is set to ignore
audio files in this folder. Use only recordings you have the right to use. Put the files directly on the server (in this folder of
the checkout, or in a folder you mount over /app/web/sounds, see deploy/docker-compose.yml) rather than into the public GitHub repo.

After adding or changing files: rebuild (docker compose up -d --build) or use the bind mount, then reload the projector page.
