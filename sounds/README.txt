YOUR OWN SOUNDS (optional)
==========================

The show already makes all of its sounds itself, so you do not need any files. If you want your own (a favourite bell, a
bhajan for the intro, applause from a recording), put audio files in this folder. A file replaces the built-in sound with the
same name. Supported formats: mp3, ogg, wav, m4a. Use lower-case names:

  intro      the game begins (a few seconds of music works well)
  ding       a correct answer is revealed
  buzzer     a strike
  fanfare    a round is won
  applause   after a round is won
  drumroll   the soundboard's drum roll
  tick       each of the last 5 seconds of a countdown
  timeup     time is up (a countdown or a survey question ends)
  sting      a new round or survey question starts
  steal      three strikes: the other team may steal
  fastmoney  the Fast Money round begins
  thinking   the soundboard's "thinking" music (it loops until stopped)

Example: sounds/buzzer.mp3

How they are picked up: the projector laptop loads this folder when you click "turn the sound on". After adding or changing a
file, reload the projector page. With Docker, either rebuild the image (docker compose up -d --build) or, to skip rebuilding,
uncomment the "../sounds:/app/web/sounds:ro" line in deploy/docker-compose.yml and restart.

A WHOLE ALTERNATIVE SET: put files in a sub-folder (for example sounds/classic/, see its README.txt). The tech picks the set in the
Sound box of the projector panel; the built-in sounds stay the default. Names missing from a set use the built-in sound.

Please only use sounds you have the right to use. The built-in sounds are original, but recordings from TV game shows,
films or commercial music are copyrighted.
