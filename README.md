# Keen.io Caching Server

This nodeJS project implements a simple caching server to proxy requests to [keen.io](http://www.keen.io). 

You will need a mongo db instance. Set `MONGOHQ_URL` environment variable to point to it (heroku does this
automatically).

Timeout of cached replies is done automatically by MongoDB with an index and an expire field. If you change the 
timeout, you need to delete the index and restart the app. The index will be re-created automatically.

