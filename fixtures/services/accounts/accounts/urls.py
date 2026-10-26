from django.urls import path
from . import views

urlpatterns = [
    path("profiles/<int:user_id>/", views.profile_detail),
    path("profiles/<int:profile_id>/delete/", views.delete_profile),
    path("profiles/", views.ProfileList.as_view()),
]
